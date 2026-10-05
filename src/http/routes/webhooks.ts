import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

import type { Env } from '../../config/env.js';
import type { PrismaClient } from '../../db/client.js';
import {
  ALL_EVENTS,
  createEndpoint,
  deleteEndpoint,
  getDelivery,
  getEndpoint,
  listDeliveries,
  listEndpoints,
  rotateSecret,
  serializeDelivery,
  serializeEndpoint,
  updateEndpoint,
  WEBHOOK_EVENT_TYPES,
  WebhookError,
  type EndpointInput,
  type WebhookDispatcher,
} from '../../webhooks/index.js';

export interface WebhookRouteDeps {
  prisma: PrismaClient;
  env: Env;
  dispatcher: WebhookDispatcher;
}

/**
 * Webhook endpoint management and the delivery log, mounted under `/webhooks`.
 * Every route is tenant-scoped by API key.
 */
export function webhookRoutes(deps: WebhookRouteDeps): FastifyPluginAsync {
  const { prisma, env, dispatcher } = deps;
  const policy = { allowPrivateUrls: env.WEBHOOK_ALLOW_PRIVATE_URLS };

  return async function (app: FastifyInstance): Promise<void> {
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof WebhookError) {
        return reply.code(err.status).send({ code: err.code, message: err.message });
      }
      return reply.send(err);
    });

    const auth = { preHandler: app.requireApiKey };

    app.get('/event-types', auth, async () => ({ data: [...WEBHOOK_EVENT_TYPES], wildcard: ALL_EVENTS }));

    app.post<{ Body: EndpointInput }>('/', auth, async (req, reply) => {
      reply.code(201);
      return createEndpoint(req.tenantId, req.body ?? {}, policy, prisma);
    });

    app.get('/', auth, async (req) => ({ data: await listEndpoints(req.tenantId, prisma) }));

    app.get<{ Params: { id: string } }>('/:id', auth, async (req) =>
      serializeEndpoint(await getEndpoint(req.tenantId, req.params.id, prisma)),
    );

    app.patch<{ Params: { id: string }; Body: EndpointInput }>('/:id', auth, async (req) =>
      updateEndpoint(req.tenantId, req.params.id, req.body ?? {}, policy, prisma),
    );

    app.delete<{ Params: { id: string } }>('/:id', auth, async (req, reply) => {
      await deleteEndpoint(req.tenantId, req.params.id, prisma);
      return reply.code(204).send();
    });

    app.post<{ Params: { id: string } }>('/:id/rotate-secret', auth, async (req) =>
      rotateSecret(req.tenantId, req.params.id, prisma),
    );

    // Sends a `webhook.test` event to this endpoint only — even if it is
    // disabled or not subscribed — and answers with the attempt's outcome.
    app.post<{ Params: { id: string } }>('/:id/test', auth, async (req) => {
      const endpoint = await getEndpoint(req.tenantId, req.params.id, prisma);
      const [deliveryId] = await dispatcher.publish(
        req.tenantId,
        'webhook.test',
        { message: 'Test event from ScormFlow', endpointId: endpoint.id },
        { endpointId: endpoint.id },
      );
      return serializeDelivery(await getDelivery(req.tenantId, deliveryId!, prisma));
    });

    app.get<{
      Params: { id: string };
      Querystring: { status?: string; eventType?: string; limit?: string; before?: string };
    }>('/:id/deliveries', auth, async (req) =>
      listDeliveries(
        {
          tenantId: req.tenantId,
          endpointId: req.params.id,
          status: req.query.status,
          eventType: req.query.eventType,
          limit: req.query.limit ? Number(req.query.limit) || undefined : undefined,
          before: req.query.before,
        },
        prisma,
      ),
    );

    app.get<{ Params: { deliveryId: string } }>('/deliveries/:deliveryId', auth, async (req) =>
      serializeDelivery(await getDelivery(req.tenantId, req.params.deliveryId, prisma)),
    );

    app.post<{ Params: { deliveryId: string } }>('/deliveries/:deliveryId/retry', auth, async (req) => {
      const delivery = await getDelivery(req.tenantId, req.params.deliveryId, prisma);
      await dispatcher.redeliver(delivery.id);
      return serializeDelivery(await getDelivery(req.tenantId, delivery.id, prisma));
    });
  };
}
