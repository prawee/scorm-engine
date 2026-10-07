import type { FastifyInstance } from 'fastify';

import type { PrismaClient } from '../db/index.js';
import type { StorageAdapter } from '../storage/types.js';

export type CheckStatus = 'ok' | 'error';

export interface ReadinessReport {
  status: 'ready' | 'not_ready';
  checks: { database: CheckStatus; storage: CheckStatus };
}

export interface HealthRouteDeps {
  prisma: PrismaClient;
  storage: StorageAdapter;
  version: string;
  /** Give up on a dependency check after this long. Default 3000. */
  checkTimeoutMs?: number;
}

/**
 * Liveness and readiness probes, served both at the root (`/healthz`,
 * `/readyz` — for load balancers and orchestrators) and inside the versioned
 * API (`/api/v1/health`, `/api/v1/ready` — for SDK clients configured with the
 * API base URL). None of them require authentication.
 *
 * Readiness runs a trivial query against the database and the storage
 * driver's own probe. Failure details go to the log, not the response, since
 * the endpoint is public.
 */
export function registerHealthRoutes(
  app: FastifyInstance,
  deps: HealthRouteDeps,
  paths: { health: string; ready: string },
): void {
  const timeoutMs = deps.checkTimeoutMs ?? 3000;

  app.get(paths.health, async () => ({ status: 'ok', version: deps.version }));

  app.get(paths.ready, async (req, reply) => {
    const [database, storage] = await Promise.all([
      runCheck('database', () => deps.prisma.$queryRaw`SELECT 1`, timeoutMs, req.log),
      runCheck('storage', () => deps.storage.check?.() ?? Promise.resolve(), timeoutMs, req.log),
    ]);
    const report: ReadinessReport = {
      status: database === 'ok' && storage === 'ok' ? 'ready' : 'not_ready',
      checks: { database, storage },
    };
    return reply.code(report.status === 'ready' ? 200 : 503).send(report);
  });
}

async function runCheck(
  name: string,
  fn: () => Promise<unknown>,
  timeoutMs: number,
  log: FastifyInstance['log'],
): Promise<CheckStatus> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
    return 'ok';
  } catch (err) {
    log.warn({ err, check: name }, 'readiness check failed');
    return 'error';
  } finally {
    clearTimeout(timer);
  }
}
