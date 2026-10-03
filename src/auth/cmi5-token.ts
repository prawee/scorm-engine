import type { FastifyInstance } from 'fastify';

/**
 * Tokens for the cmi5 launch flow.
 *
 * - The **auth token** is what a cmi5 fetch URL hands the AU. The AU sends it
 *   verbatim as `Authorization: Basic <token>` on every LRS call, so it is
 *   shaped as Basic credentials: base64(`cmi5:<jwt>`). The JWT names the
 *   session, which scopes what the LRS lets the AU read and write.
 * - The **content token** rides in the path of engine-hosted AU URLs
 *   (`/cmi5/content/<token>/index.html`), so the AU's relative sub-resource
 *   requests carry it without cookies or query strings.
 */

export const CMI5_AUTH_KIND = 'cmi5';
export const CMI5_CONTENT_KIND = 'cmi5-content';

export interface Cmi5AuthPayload {
  kind: typeof CMI5_AUTH_KIND;
  tenantId: string;
  sessionId: string;
  registrationId: string;
}

export interface Cmi5ContentPayload {
  kind: typeof CMI5_CONTENT_KIND;
  tenantId: string;
  courseId: string;
}

const BASIC_USER = 'cmi5';

export function signCmi5AuthToken(
  app: FastifyInstance,
  claims: Omit<Cmi5AuthPayload, 'kind'>,
  expiresAt: Date,
): string {
  const ttl = Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  const jwt = app.jwt.sign({ kind: CMI5_AUTH_KIND, ...claims }, { expiresIn: ttl });
  return Buffer.from(`${BASIC_USER}:${jwt}`, 'utf8').toString('base64');
}

/** Decode `Authorization: Basic …` into a cmi5 session claim, or null if it is not one. */
export function verifyCmi5Authorization(
  app: FastifyInstance,
  header: string | undefined,
): Cmi5AuthPayload | null {
  if (!header || !header.startsWith('Basic ')) return null;
  const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  if (sep === -1 || decoded.slice(0, sep) !== BASIC_USER) return null;
  try {
    const payload = app.jwt.verify<Cmi5AuthPayload>(decoded.slice(sep + 1));
    return payload.kind === CMI5_AUTH_KIND ? payload : null;
  } catch {
    return null;
  }
}

export function signCmi5ContentToken(
  app: FastifyInstance,
  claims: Omit<Cmi5ContentPayload, 'kind'>,
  ttlSeconds: number,
): string {
  return app.jwt.sign({ kind: CMI5_CONTENT_KIND, ...claims }, { expiresIn: ttlSeconds });
}

export function verifyCmi5ContentToken(
  app: FastifyInstance,
  token: string,
): Cmi5ContentPayload | null {
  try {
    const payload = app.jwt.verify<Cmi5ContentPayload>(token);
    return payload.kind === CMI5_CONTENT_KIND ? payload : null;
  } catch {
    return null;
  }
}
