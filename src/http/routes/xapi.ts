import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

import type { Env } from '../../config/env.js';
import type { PrismaClient } from '../../db/client.js';
import type { StorageAdapter } from '../../storage/types.js';
import { verifyCmi5Authorization, type Cmi5AuthPayload } from '../../auth/cmi5-token.js';
import { Cmi5Error, getActiveSession, recordSessionStatements } from '../../cmi5/index.js';
import type { EventSink } from '../../webhooks/index.js';
import {
  actorIfi,
  ActorSchema,
  deleteProfile,
  deleteState,
  deleteStates,
  getActivity,
  getPerson,
  getProfile,
  getState,
  getStatement,
  isMultipart,
  listProfileIds,
  listStateIds,
  loadAttachments,
  lrsAuthority,
  parseEtagHeader,
  parseStatementUpload,
  postProfile,
  postState,
  putProfile,
  putState,
  queryStatements,
  reconcileAttachments,
  saveAttachments,
  statementResponse,
  storeStatements,
  XAPI_VERSION,
  XapiError,
  type Actor,
  type AttachmentBody,
  type ProfileKey,
  type ProfileOwner,
  type StatementFormat,
} from '../../xapi/index.js';

export interface XapiRouteDeps {
  prisma: PrismaClient;
  /** Holds xAPI attachment bodies. */
  storage: StorageAdapter;
  env: Env;
  /** Receives cmi5 events raised by statements an AU sends. */
  events?: EventSink | undefined;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set when the request authenticated with a cmi5 session token. */
    cmi5Session: (Cmi5AuthPayload & { actorIfi: string }) | null;
  }
}

const VERSION_HEADER = 'x-experience-api-version';
const FORMATS: StatementFormat[] = ['ids', 'exact', 'canonical'];

/**
 * The built-in Learning Record Store: the xAPI 1.0.3 Statement, State, Activity
 * Profile, Agent Profile, Activity, Agent and About resources, mounted under
 * `/xapi`.
 *
 * Deviations from a textbook LRS, all deliberate:
 *  - Auth is our `X-API-Key` header rather than xAPI's Basic/OAuth, so the LRS
 *    shares one tenancy model with the rest of the engine.
 *  - Attachment bodies are stored content-addressed by SHA-2 and served back
 *    with `attachments=true`. JWS signatures are checked against the statement
 *    and verified when they embed an `x5c` certificate, but that certificate is
 *    not checked against any trust store.
 *  - The Activity and Agent resources are derived from stored statements rather
 *    than from a separate registry; see `xapi/activities.ts`.
 */
export function xapiRoutes(deps: XapiRouteDeps): FastifyPluginAsync {
  const { prisma } = deps;

  return async function (app: FastifyInstance): Promise<void> {
    // Every xAPI response advertises the version, including errors.
    app.addHook('onSend', async (_req, reply, payload) => {
      reply.header('X-Experience-API-Version', XAPI_VERSION);
      return payload;
    });

    app.decorateRequest('cmi5Session', null);

    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof XapiError || err instanceof Cmi5Error) {
        return reply.code(err.status).send({ code: err.code, message: err.message });
      }
      const failure = err as { statusCode?: number; message?: string };
      const status = failure.statusCode ?? 500;
      return reply.code(status).send({
        code: status === 500 ? 'internal_error' : 'error',
        message: status === 500 ? 'Internal server error' : (failure.message ?? 'Request failed'),
      });
    });

    // The About resource is unauthenticated and exempt from the version header —
    // it is how a client discovers which versions we speak.
    app.get('/about', async () => ({
      version: [XAPI_VERSION],
      extensions: {
        'https://scormflow.dev/lrs/extensions/implemented': [
          'statements',
          'activities',
          'activities/state',
          'activities/profile',
          'agents',
          'agents/profile',
          'attachments',
        ],
      },
    }));

    await app.register(statementRoutes(deps));
    await app.register(lookupRoutes(deps));
    await app.register(stateRoutes(deps));
    await app.register(profileRoutes(deps));
  };
}

/**
 * Shared guard: a 1.0.x version header plus either a tenant API key or a cmi5
 * session token (`Authorization: Basic`, as minted by the cmi5 fetch URL).
 *
 * A cmi5 token only reaches its own learner's data: any `agent` parameter must
 * be the registration's actor, and statement access is pinned to the session's
 * registration by the statement handlers.
 */
function guard(app: FastifyInstance, prisma: PrismaClient) {
  return async (req: FastifyRequest): Promise<void> => {
    const cmi5 = req.headers['x-api-key']
      ? null
      : verifyCmi5Authorization(app, req.headers.authorization);
    if (cmi5) {
      const session = await getActiveSession(cmi5.tenantId, cmi5.sessionId, prisma);
      if (!session) {
        throw new XapiError(401, 'invalid_session', 'cmi5 session not found');
      }
      req.tenantId = cmi5.tenantId;
      req.cmi5Session = { ...cmi5, actorIfi: session.actorIfi };

      const agentParam = (req.query as Record<string, string | undefined>)?.agent;
      if (agentParam && actorIfi(parseAgentParam(agentParam)) !== session.actorIfi) {
        throw XapiError.forbidden('A cmi5 session may only access its own learner');
      }
    } else {
      await app.requireApiKey(req);
    }

    const raw = req.headers[VERSION_HEADER];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (!value) {
      throw XapiError.badRequest(
        'Missing X-Experience-API-Version header',
        'missing_version_header',
      );
    }
    if (!/^1\.0(\.\d+)?$/.test(value.trim())) {
      throw XapiError.badRequest(
        `Unsupported X-Experience-API-Version "${value}"; this LRS implements ${XAPI_VERSION}`,
        'unsupported_version',
      );
    }
  };
}

function authorityFor(tenantId: string, env: Env): Actor {
  return lrsAuthority(tenantId, env.XAPI_AUTHORITY_HOMEPAGE);
}

function statementRoutes(deps: XapiRouteDeps): FastifyPluginAsync {
  const { prisma, storage, env } = deps;

  return async function (app: FastifyInstance): Promise<void> {
    const preHandler = guard(app, prisma);

    // Statements with attachments arrive as multipart/mixed; keep the raw bytes
    // so attachment bodies reach the hash check untouched.
    app.addContentTypeParser('multipart/mixed', { parseAs: 'buffer' }, (_req, body, done) => {
      done(null, body);
    });

    app.put<{ Querystring: { statementId?: string }; Body: unknown }>(
      '/statements',
      { preHandler },
      async (req, reply) => {
        const statementId = req.query.statementId;
        if (!statementId) {
          throw XapiError.badRequest('statementId is required for PUT /statements');
        }
        const upload = readUpload(req);
        if (Array.isArray(upload.body)) {
          throw XapiError.badRequest('PUT /statements takes a single statement, not an array');
        }
        await store(req, [upload.body], upload.attachments, statementId);
        return reply.code(204).send();
      },
    );

    app.post<{ Body: unknown }>('/statements', { preHandler }, async (req, reply) => {
      const upload = readUpload(req);
      const statements = Array.isArray(upload.body) ? upload.body : [upload.body];
      const result = await store(req, statements, upload.attachments);
      return reply.code(200).send(result.ids);
    });

    function readUpload(req: FastifyRequest): { body: unknown; attachments: AttachmentBody[] } {
      const contentType = contentTypeOf(req);
      if (isMultipart(contentType)) {
        return parseStatementUpload(bodyBuffer(req.body), contentType);
      }
      return { body: req.body, attachments: [] };
    }

    /**
     * Attachment bodies are checked against the statements and saved before the
     * statements themselves, so a stored statement never lacks its bodies.
     * Statements under a cmi5 session go through the cmi5 rules first.
     */
    async function store(
      req: FastifyRequest,
      statements: unknown[],
      attachments: AttachmentBody[],
      statementId?: string,
    ) {
      reconcileAttachments(statements, attachments);
      await saveAttachments(req.tenantId, attachments, storage);

      if (req.cmi5Session) {
        return recordSessionStatements(
          {
            tenantId: req.tenantId,
            sessionId: req.cmi5Session.sessionId,
            statements,
            statementId,
            homePage: env.XAPI_AUTHORITY_HOMEPAGE,
            events: deps.events,
          },
          prisma,
        );
      }
      return storeStatements(
        {
          tenantId: req.tenantId,
          statements,
          statementId,
          authority: authorityFor(req.tenantId, env),
          events: deps.events,
        },
        prisma,
      );
    }

    app.get<{ Querystring: Record<string, string | undefined> }>(
      '/statements',
      { preHandler },
      async (req, reply) => {
        const q = req.query;
        reply.header('X-Experience-API-Consistent-Through', new Date().toISOString());

        const format = parseFormat(q.format);
        const withAttachments = parseBool(q.attachments) ?? false;
        const byId = q.statementId;
        const byVoidedId = q.voidedStatementId;

        if (byId && byVoidedId) {
          throw XapiError.badRequest('statementId and voidedStatementId are mutually exclusive');
        }

        if (byId || byVoidedId) {
          const conflicting = ['agent', 'verb', 'activity', 'registration', 'since', 'until', 'limit']
            .filter((key) => q[key] !== undefined);
          if (conflicting.length > 0) {
            throw XapiError.badRequest(
              `statementId cannot be combined with ${conflicting.join(', ')}`,
            );
          }
          const statement = await getStatement(
            req.tenantId,
            (byId ?? byVoidedId) as string,
            { voided: Boolean(byVoidedId), format },
            prisma,
          );
          const outsideSession =
            req.cmi5Session &&
            (statement as { context?: { registration?: string } } | null)?.context?.registration !==
              req.cmi5Session.registrationId;
          if (!statement || outsideSession) {
            return reply.code(404).send({ code: 'statement_not_found', message: 'Statement not found' });
          }
          return send(statement, [statement]);
        }

        let registration = q.registration;
        if (req.cmi5Session) {
          if (registration && registration !== req.cmi5Session.registrationId) {
            throw XapiError.forbidden('A cmi5 session may only query its own registration');
          }
          registration = req.cmi5Session.registrationId;
        }

        const page = await queryStatements(
          {
            tenantId: req.tenantId,
            agent: q.agent ? parseAgentParam(q.agent) : undefined,
            verb: q.verb,
            activity: q.activity,
            registration,
            relatedActivities: parseBool(q.related_activities),
            relatedAgents: parseBool(q.related_agents),
            since: parseDate(q.since, 'since'),
            until: parseDate(q.until, 'until'),
            limit: parseLimit(q.limit),
            ascending: parseBool(q.ascending),
            format,
            offset: parseOffset(q.cursor),
          },
          prisma,
        );

        return send(
          {
            statements: page.statements,
            more: page.nextOffset === null ? '' : moreUrl(req, page.nextOffset),
          },
          page.statements,
        );

        /** `attachments=true` wraps the JSON and the bodies it references in multipart/mixed. */
        async function send(json: unknown, statements: unknown[]) {
          if (!withAttachments) return json;
          const bodies = await loadAttachments(req.tenantId, statements, storage);
          const multipart = statementResponse(json, bodies);
          return reply.type(multipart.contentType).send(multipart.body);
        }
      },
    );
  };
}

/** The Activity and Agent resources: read-only views derived from statements. */
function lookupRoutes(deps: XapiRouteDeps): FastifyPluginAsync {
  const { prisma } = deps;

  return async function (app: FastifyInstance): Promise<void> {
    const preHandler = guard(app, prisma);

    app.get<{ Querystring: { activityId?: string } }>(
      '/activities',
      { preHandler },
      async (req, reply) => {
        const activityId = requireParam(req.query.activityId, 'activityId');
        const activity = await getActivity(req.tenantId, activityId, prisma);
        if (!activity) {
          return reply
            .code(404)
            .send({ code: 'activity_not_found', message: 'No statement references this activity' });
        }
        return activity;
      },
    );

    // Unlike /activities, an unknown agent is not a 404: the spec wants a Person
    // back regardless, carrying at least the IFI that was asked for.
    app.get<{ Querystring: { agent?: string } }>('/agents', { preHandler }, async (req) => {
      const agent = parseAgentParam(requireParam(req.query.agent, 'agent'));
      return getPerson(req.tenantId, agent, prisma);
    });
  };
}

/**
 * The Activity Profile and Agent Profile resources.
 *
 * Both are mounted from one factory because the spec gives them identical
 * behaviour; only the owner query parameter differs (`activityId` vs `agent`).
 */
function profileRoutes(deps: XapiRouteDeps): FastifyPluginAsync {
  const { prisma, env } = deps;

  return async function (app: FastifyInstance): Promise<void> {
    const preHandler = guard(app, prisma);

    // Profile documents are opaque bodies, exactly like State documents.
    app.removeAllContentTypeParsers();
    app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => {
      done(null, body);
    });

    const preconditionsFrom = (req: FastifyRequest) => ({
      ifMatch: parseEtagHeader(req.headers['if-match']),
      ifNoneMatch: parseEtagHeader(req.headers['if-none-match']),
      required: env.XAPI_REQUIRE_PRECONDITIONS,
    });

    const mount = (
      path: string,
      ownerFrom: (req: FastifyRequest<{ Querystring: ProfileQuery }>) => ProfileOwner,
    ): void => {
      const keyFrom = (req: FastifyRequest<{ Querystring: ProfileQuery }>): ProfileKey => ({
        ...ownerFrom(req),
        profileId: requireParam(req.query.profileId, 'profileId'),
      });

      app.get<{ Querystring: ProfileQuery }>(path, { preHandler }, async (req, reply) => {
        if (!req.query.profileId) {
          const ids = await listProfileIds(
            { owner: ownerFrom(req), since: parseDate(req.query.since, 'since') },
            prisma,
          );
          return reply.type('application/json').send(ids);
        }

        const doc = await getProfile(keyFrom(req), prisma);
        if (!doc) {
          return reply
            .code(404)
            .send({ code: 'profile_not_found', message: 'Profile document not found' });
        }
        return reply
          .header('ETag', doc.etag)
          .header('Last-Modified', doc.updatedAt.toUTCString())
          .type(doc.contentType)
          .send(doc.content);
      });

      app.put<{ Querystring: ProfileQuery; Body: Buffer }>(
        path,
        { preHandler },
        async (req, reply) => {
          const doc = await putProfile(
            {
              key: keyFrom(req),
              content: bodyBuffer(req.body),
              contentType: contentTypeOf(req),
              preconditions: preconditionsFrom(req),
            },
            prisma,
          );
          return reply.header('ETag', doc.etag).code(204).send();
        },
      );

      app.post<{ Querystring: ProfileQuery; Body: Buffer }>(
        path,
        { preHandler },
        async (req, reply) => {
          const doc = await postProfile(
            {
              key: keyFrom(req),
              content: bodyBuffer(req.body),
              contentType: contentTypeOf(req),
              preconditions: preconditionsFrom(req),
            },
            prisma,
          );
          return reply.header('ETag', doc.etag).code(204).send();
        },
      );

      app.delete<{ Querystring: ProfileQuery }>(path, { preHandler }, async (req, reply) => {
        await deleteProfile(keyFrom(req), prisma, preconditionsFrom(req));
        return reply.code(204).send();
      });
    };

    mount('/activities/profile', (req) => ({
      tenantId: req.tenantId,
      scope: 'ACTIVITY',
      activityId: requireParam(req.query.activityId, 'activityId'),
    }));

    mount('/agents/profile', (req) => ({
      tenantId: req.tenantId,
      scope: 'AGENT',
      agent: parseAgentParam(requireParam(req.query.agent, 'agent')),
    }));
  };
}

function stateRoutes(deps: XapiRouteDeps): FastifyPluginAsync {
  const { prisma, env } = deps;

  return async function (app: FastifyInstance): Promise<void> {
    const preHandler = guard(app, prisma);

    // State documents are opaque bodies — JSON, plain text, or binary — so this
    // encapsulated scope keeps them as raw buffers instead of letting Fastify's
    // JSON parser rewrite (or reject) them.
    app.removeAllContentTypeParsers();
    app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => {
      done(null, body);
    });

    const keyFrom = (req: FastifyRequest<{ Querystring: StateQuery }>, requireStateId: boolean) => {
      const q = req.query;
      if (!q.activityId) throw XapiError.badRequest('activityId is required');
      if (!q.agent) throw XapiError.badRequest('agent is required');
      if (requireStateId && !q.stateId) throw XapiError.badRequest('stateId is required');
      return {
        tenantId: req.tenantId,
        activityId: q.activityId,
        agent: parseAgentParam(q.agent),
        registration: q.registration,
        stateId: q.stateId ?? '',
      };
    };

    const preconditionsFrom = (req: FastifyRequest) => ({
      ifMatch: parseEtagHeader(req.headers['if-match']),
      ifNoneMatch: parseEtagHeader(req.headers['if-none-match']),
      required: env.XAPI_REQUIRE_PRECONDITIONS,
    });

    app.get<{ Querystring: StateQuery }>(
      '/activities/state',
      { preHandler },
      async (req, reply) => {
        const q = req.query;
        if (!q.stateId) {
          const ids = await listStateIds(
            {
              tenantId: req.tenantId,
              activityId: requireParam(q.activityId, 'activityId'),
              agent: parseAgentParam(requireParam(q.agent, 'agent')),
              registration: q.registration,
              since: parseDate(q.since, 'since'),
            },
            prisma,
          );
          return reply.type('application/json').send(ids);
        }

        const doc = await getState(keyFrom(req, true), prisma);
        if (!doc) {
          return reply.code(404).send({ code: 'state_not_found', message: 'State document not found' });
        }
        return reply
          .header('ETag', doc.etag)
          .header('Last-Modified', doc.updatedAt.toUTCString())
          .type(doc.contentType)
          .send(doc.content);
      },
    );

    app.put<{ Querystring: StateQuery; Body: Buffer }>(
      '/activities/state',
      { preHandler },
      async (req, reply) => {
        const doc = await putState(
          {
            key: keyFrom(req, true),
            content: bodyBuffer(req.body),
            contentType: contentTypeOf(req),
            preconditions: preconditionsFrom(req),
          },
          prisma,
        );
        return reply.header('ETag', doc.etag).code(204).send();
      },
    );

    app.post<{ Querystring: StateQuery; Body: Buffer }>(
      '/activities/state',
      { preHandler },
      async (req, reply) => {
        const doc = await postState(
          {
            key: keyFrom(req, true),
            content: bodyBuffer(req.body),
            contentType: contentTypeOf(req),
            preconditions: preconditionsFrom(req),
          },
          prisma,
        );
        return reply.header('ETag', doc.etag).code(204).send();
      },
    );

    app.delete<{ Querystring: StateQuery }>(
      '/activities/state',
      { preHandler },
      async (req, reply) => {
        const q = req.query;
        if (q.stateId) {
          await deleteState(keyFrom(req, true), prisma, preconditionsFrom(req));
        } else {
          await deleteStates(
            {
              tenantId: req.tenantId,
              activityId: requireParam(q.activityId, 'activityId'),
              agent: parseAgentParam(requireParam(q.agent, 'agent')),
              registration: q.registration,
            },
            prisma,
          );
        }
        return reply.code(204).send();
      },
    );
  };
}

interface StateQuery {
  activityId?: string;
  agent?: string;
  registration?: string;
  stateId?: string;
  since?: string;
}

interface ProfileQuery {
  activityId?: string;
  agent?: string;
  profileId?: string;
  since?: string;
}

function requireParam(value: string | undefined, name: string): string {
  if (!value) throw XapiError.badRequest(`${name} is required`);
  return value;
}

function bodyBuffer(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) return body;
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  return Buffer.from(JSON.stringify(body), 'utf8');
}

function contentTypeOf(req: FastifyRequest): string {
  const raw = req.headers['content-type'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.trim() || 'application/octet-stream';
}

/** `agent` / `instructor` query params arrive as a JSON-encoded Agent or Group. */
function parseAgentParam(raw: string): Actor {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw XapiError.badRequest('agent must be a JSON-encoded Agent or Group', 'invalid_agent');
  }
  const parsed = ActorSchema.safeParse(decoded);
  if (!parsed.success) {
    throw XapiError.badRequest(
      `agent is not a valid Agent or Group — ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      'invalid_agent',
    );
  }
  return parsed.data;
}

function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return ['1', 'true', 'yes'].includes(value.trim().toLowerCase());
}

function parseDate(value: string | undefined, name: string): Date | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw XapiError.badRequest(`${name} must be an ISO 8601 timestamp`);
  }
  return new Date(parsed);
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 0) {
    throw XapiError.badRequest('limit must be a non-negative integer');
  }
  return limit;
}

function parseOffset(value: string | undefined): number {
  if (value === undefined) return 0;
  const offset = Number(value);
  if (!Number.isInteger(offset) || offset < 0) {
    throw XapiError.badRequest('cursor is not valid');
  }
  return offset;
}

function parseFormat(value: string | undefined): StatementFormat {
  if (value === undefined) return 'exact';
  if (!FORMATS.includes(value as StatementFormat)) {
    throw XapiError.badRequest(`format must be one of ${FORMATS.join(', ')}`);
  }
  return value as StatementFormat;
}

/** The `more` link: this exact query, resumed at the next offset. */
function moreUrl(req: FastifyRequest, offset: number): string {
  const url = new URL(req.url, 'http://lrs.invalid');
  url.searchParams.set('cursor', String(offset));
  return `${url.pathname}${url.search}`;
}
