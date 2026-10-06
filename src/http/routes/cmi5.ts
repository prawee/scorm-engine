import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

import type { Env } from '../../config/env.js';
import type { PrismaClient } from '../../db/client.js';
import { isTenantKey } from '../../storage/scoped.js';
import { type StorageAdapter, StorageNotFoundError } from '../../storage/types.js';
import {
  signCmi5AuthToken,
  signCmi5ContentToken,
  verifyCmi5ContentToken,
} from '../../auth/cmi5-token.js';
import {
  Cmi5Error,
  createRegistration,
  getLearnerPreferences,
  getRegistrationView,
  importCmi5Course,
  launchAu,
  parseLearnerPreferences,
  readCourseStructure,
  redeemFetchKey,
  setLearnerPreferences,
  waiveAu,
} from '../../cmi5/index.js';
import type { EventSink } from '../../webhooks/index.js';
import { contentTypeFor } from './content.js';

export interface Cmi5RouteDeps {
  prisma: PrismaClient;
  storage: StorageAdapter;
  env: Env;
  events?: EventSink | undefined;
}

/** A learner named either by a full xAPI actor or by an id in the engine's account namespace. */
interface LearnerRef {
  actor?: unknown;
  learnerId?: string | undefined;
  learnerName?: string | undefined;
}

interface RegistrationBody extends LearnerRef {
  courseId?: string;
  learnerPreferences?: unknown;
}

interface PreferencesBody extends LearnerRef {
  languagePreference?: unknown;
  audioPreference?: unknown;
}

interface LaunchBody {
  auId?: string;
  launchMode?: string;
  returnUrl?: string;
}

interface WaiveBody {
  auId?: string;
  reason?: string;
}

/**
 * cmi5 course hosting, mounted under `/cmi5`.
 *
 * The engine plays the LMS role: it imports course structures, manages
 * registrations, launches AUs (LaunchData + `launched` + launch URL), hands out
 * one-time fetch URLs, and — through the built-in LRS — enforces the cmi5
 * statement rules on whatever the AU sends back.
 */
export function cmi5Routes(deps: Cmi5RouteDeps): FastifyPluginAsync {
  const { prisma, storage, env } = deps;

  return async function (app: FastifyInstance): Promise<void> {
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof Cmi5Error) {
        return reply.code(err.status).send({ code: err.code, message: err.message });
      }
      return reply.send(err);
    });

    const auth = { preHandler: app.requireApiKey };

    // --- Courses ----------------------------------------------------------

    app.post('/courses', auth, async (req, reply) => {
      const { buffer, title } = await readUpload(req);
      const id = await importCmi5Course({ tenantId: req.tenantId, buffer, titleOverride: title }, { prisma, storage });
      reply.code(201);
      return serializeCourse(await loadCourse(req.tenantId, id));
    });

    app.post('/courses/validate', auth, async (req) => {
      const { buffer } = await readUpload(req);
      try {
        const { structure } = await readCourseStructure({ buffer });
        return { valid: true, errors: [], structure };
      } catch (err) {
        if (err instanceof Cmi5Error) {
          return { valid: false, errors: [{ code: err.code, message: err.message }], structure: null };
        }
        throw err;
      }
    });

    app.get('/courses', auth, async (req) => {
      const courses = await prisma.cmi5Course.findMany({
        where: { tenantId: req.tenantId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      const data = [];
      for (const course of courses) {
        data.push(serializeCourse({ course, aus: await aus(course.id) }));
      }
      return { data, pagination: { nextCursor: null, hasMore: false } };
    });

    app.get<{ Params: { id: string } }>('/courses/:id', auth, async (req) =>
      serializeCourse(await loadCourse(req.tenantId, req.params.id)),
    );

    app.delete<{ Params: { id: string } }>('/courses/:id', auth, async (req, reply) => {
      const { course } = await loadCourse(req.tenantId, req.params.id);
      await prisma.cmi5Course.delete({ where: { id: course.id } });
      if (course.storageKey) {
        await storage.delete(course.storageKey).catch((err: unknown) => {
          req.log.warn({ err, storageKey: course.storageKey }, 'storage cleanup failed');
        });
      }
      return reply.code(204).send();
    });

    // --- Registrations ----------------------------------------------------

    app.post<{ Body: RegistrationBody }>('/registrations', auth, async (req, reply) => {
      const body = req.body ?? {};
      if (!body.courseId) throw new Cmi5Error(400, 'invalid_request', 'courseId is required');
      const actor = resolveActor(body);
      // Validate before creating anything, so a bad payload leaves no registration behind.
      const preferences =
        body.learnerPreferences === undefined ? undefined : parseLearnerPreferences(body.learnerPreferences);

      const id = await createRegistration({ tenantId: req.tenantId, courseId: body.courseId, actor }, prisma);
      if (preferences) await setLearnerPreferences(req.tenantId, actor, preferences, prisma);
      reply.code(201);
      return getRegistrationView(req.tenantId, id, prisma);
    });

    // --- Learner preferences (cmi5LearnerPreferences agent profile) --------

    app.get<{ Querystring: { agent?: string; learnerId?: string } }>(
      '/learner-preferences',
      auth,
      async (req) => {
        let agent: unknown;
        if (req.query.agent) {
          try {
            agent = JSON.parse(req.query.agent);
          } catch {
            throw new Cmi5Error(400, 'invalid_actor', 'agent must be a JSON-encoded xAPI Agent');
          }
        }
        const actor = resolveActor({ actor: agent, learnerId: req.query.learnerId });
        const preferences = await getLearnerPreferences(req.tenantId, actor, prisma);
        if (!preferences) throw new Cmi5Error(404, 'preferences_not_found', 'No preferences stored for this learner');
        return preferences;
      },
    );

    app.put<{ Body: PreferencesBody }>('/learner-preferences', auth, async (req) => {
      const body = req.body ?? {};
      const actor = resolveActor(body);
      const preferences = parseLearnerPreferences({
        languagePreference: body.languagePreference,
        audioPreference: body.audioPreference,
      });
      return setLearnerPreferences(req.tenantId, actor, preferences, prisma);
    });

    app.get<{ Params: { id: string } }>('/registrations/:id', auth, async (req) => {
      const view = await getRegistrationView(req.tenantId, req.params.id, prisma);
      if (!view) throw new Cmi5Error(404, 'registration_not_found', 'Registration not found');
      return view;
    });

    app.post<{ Params: { id: string }; Body: LaunchBody }>(
      '/registrations/:id/launch',
      auth,
      async (req) => {
        const body = req.body ?? {};
        if (!body.auId) throw new Cmi5Error(400, 'invalid_request', 'auId is required');
        const apiBase = baseUrl(req);
        const ttl = env.JWT_ATTEMPT_TTL_SECONDS;
        const tenantId = req.tenantId;

        return launchAu(
          {
            tenantId,
            registrationId: req.params.id,
            auId: body.auId,
            launchMode: body.launchMode,
            returnUrl: body.returnUrl,
            ttlSeconds: ttl,
            lrsEndpoint: `${apiBase}/xapi/`,
            fetchUrlFor: (sessionId, key) =>
              `${apiBase}/cmi5/fetch?session=${encodeURIComponent(sessionId)}&key=${encodeURIComponent(key)}`,
            contentUrlFor: (courseId, path) =>
              `${apiBase}/cmi5/content/${signCmi5ContentToken(app, { tenantId, courseId }, ttl)}/${path}`,
            homePage: env.XAPI_AUTHORITY_HOMEPAGE,
            events: deps.events,
          },
          prisma,
        );
      },
    );

    app.post<{ Params: { id: string }; Body: WaiveBody }>(
      '/registrations/:id/waive',
      auth,
      async (req) => {
        const body = req.body ?? {};
        if (!body.auId || !body.reason) {
          throw new Cmi5Error(400, 'invalid_request', 'auId and reason are required');
        }
        await waiveAu(
          {
            tenantId: req.tenantId,
            registrationId: req.params.id,
            auId: body.auId,
            reason: body.reason,
            homePage: env.XAPI_AUTHORITY_HOMEPAGE,
            events: deps.events,
          },
          prisma,
        );
        return getRegistrationView(req.tenantId, req.params.id, prisma);
      },
    );

    // --- AU-facing (no API key) -------------------------------------------

    // The fetch URL. Authenticated by the one-time key it carries; answers in
    // the shape cmi5 §8.2.3 prescribes, including for errors.
    app.post<{ Querystring: { session?: string; key?: string } }>('/fetch', async (req, reply) => {
      const { session, key } = req.query;
      try {
        if (!session || !key) throw new Cmi5Error(401, '2', 'Fetch URL is not valid');
        const claim = await redeemFetchKey(session, key, prisma);
        const token = signCmi5AuthToken(
          app,
          { tenantId: claim.tenantId, sessionId: claim.sessionId, registrationId: claim.registrationId },
          claim.expiresAt,
        );
        return reply.header('Cache-Control', 'no-store').send({ 'auth-token': token });
      } catch (err) {
        if (err instanceof Cmi5Error) {
          return fetchError(reply, err.status, err.code, err.message);
        }
        throw err;
      }
    });

    // `/content/<token>/<path>`. Matched as one wildcard because the token is
    // longer than Fastify's path-parameter limit.
    app.get<{ Params: { '*': string } }>('/content/*', async (req, reply) => {
      const rest = req.params['*'] ?? '';
      const slash = rest.indexOf('/');
      const token = slash === -1 ? rest : rest.slice(0, slash);
      const relPath = slash === -1 ? '' : rest.slice(slash + 1);
      if (!relPath || relPath.includes('..') || relPath.startsWith('/')) {
        return reply.code(400).send({ code: 'invalid_path', message: 'Invalid content path' });
      }
      const claim = verifyCmi5ContentToken(app, token);
      if (!claim) {
        return reply.code(401).send({ code: 'unauthorized', message: 'Content access denied' });
      }
      const course = await prisma.cmi5Course.findFirst({
        where: { id: claim.courseId, tenantId: claim.tenantId },
        select: { storageKey: true },
      });
      if (!course?.storageKey) {
        return reply.code(404).send({ code: 'course_not_found', message: 'Course not found' });
      }
      if (!isTenantKey(claim.tenantId, course.storageKey)) {
        req.log.error({ storageKey: course.storageKey }, 'course storage key is outside its tenant prefix');
        return reply.code(404).send({ code: 'course_not_found', message: 'Course not found' });
      }
      try {
        const stream = await storage.get(`${course.storageKey}/${relPath}`);
        reply.header('Cache-Control', 'private, max-age=300');
        reply.type(contentTypeFor(relPath));
        return reply.send(stream);
      } catch (err) {
        if (err instanceof StorageNotFoundError) {
          return reply.code(404).send({ code: 'file_not_found', message: 'File not found' });
        }
        throw err;
      }
    });
  };

  function resolveActor(ref: LearnerRef): unknown {
    if (ref.actor !== undefined) return ref.actor;
    if (ref.learnerId) {
      return {
        objectType: 'Agent',
        ...(ref.learnerName ? { name: ref.learnerName } : {}),
        account: { homePage: env.XAPI_AUTHORITY_HOMEPAGE, name: ref.learnerId },
      };
    }
    throw new Cmi5Error(400, 'invalid_request', 'actor or learnerId is required');
  }

  async function aus(courseId: string) {
    return prisma.cmi5Au.findMany({ where: { courseId }, orderBy: { order: 'asc' } });
  }

  async function loadCourse(tenantId: string, id: string) {
    const course = await prisma.cmi5Course.findFirst({ where: { id, tenantId } });
    if (!course) throw new Cmi5Error(404, 'course_not_found', 'cmi5 course not found');
    return { course, aus: await aus(course.id) };
  }
}

async function readUpload(req: FastifyRequest): Promise<{ buffer: Buffer; title?: string }> {
  const file = await req.file();
  if (!file) {
    throw new Cmi5Error(400, 'invalid_request', 'Expected a multipart file upload named "file"');
  }
  const buffer = await file.toBuffer();
  const field = file.fields['title'];
  const one = Array.isArray(field) ? field[0] : field;
  const title =
    one && typeof one === 'object' && 'value' in one && typeof one.value === 'string'
      ? one.value
      : undefined;
  return title ? { buffer, title } : { buffer };
}

function fetchError(reply: FastifyReply, status: number, code: string, text: string) {
  const errorCode = ['1', '2', '3'].includes(code) ? code : '3';
  return reply
    .code(status)
    .header('Cache-Control', 'no-store')
    .send({ 'error-code': errorCode, 'error-text': text });
}

type CourseRow = Awaited<ReturnType<PrismaClient['cmi5Course']['findFirst']>> & {};
type AuRow = Awaited<ReturnType<PrismaClient['cmi5Au']['findFirst']>> & {};

function serializeCourse({ course, aus }: { course: CourseRow; aus: AuRow[] }) {
  const structure = course.structure as { children?: unknown } | null;
  return {
    id: course.id,
    publisherId: course.publisherId,
    activityId: course.activityId,
    title: course.title,
    description: course.description,
    hosted: course.storageKey !== null,
    aus: aus.map((au) => ({
      id: au.id,
      publisherId: au.publisherId,
      activityId: au.activityId,
      title: au.title,
      description: au.description,
      url: au.url,
      launchMethod: au.launchMethod,
      moveOn: au.moveOn,
      masteryScore: au.masteryScore,
      activityType: au.activityType,
      launchParameters: au.launchParameters,
    })),
    structure: structure?.children ?? [],
    createdAt: course.createdAt.toISOString(),
    updatedAt: course.updatedAt.toISOString(),
  };
}

function baseUrl(req: FastifyRequest): string {
  const host = req.headers['host'];
  const proto = (req.headers['x-forwarded-proto'] as string | undefined) || req.protocol;
  return `${proto}://${host}/api/v1`;
}
