import type { PrismaClient } from '../db/client.js';
import { ALL_EVENTS, isWebhookEventType, WEBHOOK_EVENT_TYPES } from './events.js';
import { generateWebhookSecret } from './signing.js';
import { assertDeliverableUrl, WebhookUrlError } from './urls.js';

/** Endpoint and delivery-log management behind the `/webhooks` routes. */

export class WebhookError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'WebhookError';
  }
}

type EndpointRow = Awaited<ReturnType<PrismaClient['webhookEndpoint']['findFirst']>> & {};
type DeliveryRow = Awaited<ReturnType<PrismaClient['webhookDelivery']['findFirst']>> & {};

export interface EndpointView {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DeliveryView {
  id: string;
  endpointId: string;
  eventId: string;
  eventType: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  attempts: number;
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  lastStatusCode: number | null;
  lastError: string | null;
  lastResponse: string | null;
  deliveredAt: string | null;
  createdAt: string;
  payload: unknown;
}

export function serializeEndpoint(row: EndpointRow): EndpointView {
  return {
    id: row.id,
    url: row.url,
    description: row.description,
    events: row.events,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function serializeDelivery(row: DeliveryRow): DeliveryView {
  const iso = (d: Date | null) => d?.toISOString() ?? null;
  return {
    id: row.id,
    endpointId: row.endpointId,
    eventId: row.eventId,
    eventType: row.eventType,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: iso(row.nextAttemptAt),
    lastAttemptAt: iso(row.lastAttemptAt),
    lastStatusCode: row.lastStatusCode,
    lastError: row.lastError,
    lastResponse: row.lastResponse,
    deliveredAt: iso(row.deliveredAt),
    createdAt: row.createdAt.toISOString(),
    payload: row.payload,
  };
}

export interface EndpointInput {
  url?: unknown;
  events?: unknown;
  description?: unknown;
  enabled?: unknown;
}

interface Policy {
  allowPrivateUrls: boolean;
}

export async function createEndpoint(
  tenantId: string,
  input: EndpointInput,
  policy: Policy,
  prisma: PrismaClient,
): Promise<EndpointView & { secret: string }> {
  if (input.url === undefined) throw new WebhookError(400, 'invalid_request', 'url is required');
  if (input.events === undefined) throw new WebhookError(400, 'invalid_request', 'events is required');
  const secret = generateWebhookSecret();
  const row = await prisma.webhookEndpoint.create({
    data: {
      tenantId,
      url: parseUrl(input.url, policy),
      events: parseEvents(input.events),
      description: parseDescription(input.description) ?? null,
      enabled: parseEnabled(input.enabled) ?? true,
      secret,
    },
  });
  return { ...serializeEndpoint(row), secret };
}

export async function listEndpoints(tenantId: string, prisma: PrismaClient): Promise<EndpointView[]> {
  const rows = await prisma.webhookEndpoint.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' } });
  return rows.map(serializeEndpoint);
}

export async function getEndpoint(tenantId: string, id: string, prisma: PrismaClient): Promise<EndpointRow> {
  const row = await prisma.webhookEndpoint.findFirst({ where: { id, tenantId } });
  if (!row) throw new WebhookError(404, 'webhook_not_found', 'Webhook endpoint not found');
  return row;
}

export async function updateEndpoint(
  tenantId: string,
  id: string,
  input: EndpointInput,
  policy: Policy,
  prisma: PrismaClient,
): Promise<EndpointView> {
  await getEndpoint(tenantId, id, prisma);
  const data: Record<string, unknown> = {};
  if (input.url !== undefined) data.url = parseUrl(input.url, policy);
  if (input.events !== undefined) data.events = parseEvents(input.events);
  if (input.description !== undefined) data.description = parseDescription(input.description);
  if (input.enabled !== undefined) data.enabled = parseEnabled(input.enabled);
  const row = await prisma.webhookEndpoint.update({ where: { id }, data });
  return serializeEndpoint(row);
}

export async function deleteEndpoint(tenantId: string, id: string, prisma: PrismaClient): Promise<void> {
  await getEndpoint(tenantId, id, prisma);
  await prisma.webhookEndpoint.delete({ where: { id } });
}

/** Replace the signing secret. The old one stops working immediately. */
export async function rotateSecret(
  tenantId: string,
  id: string,
  prisma: PrismaClient,
): Promise<EndpointView & { secret: string }> {
  await getEndpoint(tenantId, id, prisma);
  const secret = generateWebhookSecret();
  const row = await prisma.webhookEndpoint.update({ where: { id }, data: { secret } });
  return { ...serializeEndpoint(row), secret };
}

export interface ListDeliveriesInput {
  tenantId: string;
  endpointId: string;
  status?: string | undefined;
  eventType?: string | undefined;
  limit?: number | undefined;
  /** Only deliveries created before this time — the previous page's `nextCursor`. */
  before?: string | undefined;
}

export const DELIVERY_STATUSES = ['PENDING', 'SUCCEEDED', 'FAILED'] as const;

/** Newest first. */
export async function listDeliveries(
  input: ListDeliveriesInput,
  prisma: PrismaClient,
): Promise<{ data: DeliveryView[]; pagination: { nextCursor: string | null; hasMore: boolean } }> {
  await getEndpoint(input.tenantId, input.endpointId, prisma);
  const status = input.status?.toUpperCase();
  if (status && !(DELIVERY_STATUSES as readonly string[]).includes(status)) {
    throw new WebhookError(400, 'invalid_request', `status must be one of ${DELIVERY_STATUSES.join(', ')}`);
  }
  let before: Date | undefined;
  if (input.before) {
    before = new Date(input.before);
    if (Number.isNaN(before.getTime())) throw new WebhookError(400, 'invalid_request', 'before must be an ISO timestamp');
  }
  const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);

  const rows = await prisma.webhookDelivery.findMany({
    where: {
      tenantId: input.tenantId,
      endpointId: input.endpointId,
      ...(status ? { status: status as (typeof DELIVERY_STATUSES)[number] } : {}),
      ...(input.eventType ? { eventType: input.eventType } : {}),
      ...(before ? { createdAt: { lt: before } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
  });
  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  return {
    data: page.map(serializeDelivery),
    pagination: { nextCursor: hasMore ? page.at(-1)!.createdAt.toISOString() : null, hasMore },
  };
}

export async function getDelivery(tenantId: string, id: string, prisma: PrismaClient): Promise<DeliveryRow> {
  const row = await prisma.webhookDelivery.findFirst({ where: { id, tenantId } });
  if (!row) throw new WebhookError(404, 'delivery_not_found', 'Webhook delivery not found');
  return row;
}

// ---- input parsing ---------------------------------------------------------

function parseUrl(value: unknown, policy: Policy): string {
  if (typeof value !== 'string') throw new WebhookError(400, 'invalid_url', 'url must be a string');
  try {
    return assertDeliverableUrl(value.trim(), policy.allowPrivateUrls).toString();
  } catch (err) {
    if (err instanceof WebhookUrlError) throw new WebhookError(400, 'invalid_url', err.message);
    throw err;
  }
}

function parseEvents(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === 'string')) {
    throw new WebhookError(400, 'invalid_events', 'events must be a non-empty array of event types');
  }
  const unknown = value.filter((v) => v !== ALL_EVENTS && !isWebhookEventType(v));
  if (unknown.length > 0) {
    throw new WebhookError(
      400,
      'invalid_events',
      `Unknown event type(s): ${unknown.join(', ')}. Known: ${WEBHOOK_EVENT_TYPES.join(', ')}, or "*"`,
    );
  }
  return [...new Set(value as string[])];
}

function parseDescription(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 500) {
    throw new WebhookError(400, 'invalid_request', 'description must be a string of at most 500 characters');
  }
  return value.trim() || null;
}

function parseEnabled(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new WebhookError(400, 'invalid_request', 'enabled must be a boolean');
  return value;
}
