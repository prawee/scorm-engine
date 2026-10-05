import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Delivery signatures.
 *
 * Every request carries `ScormFlow-Signature: t=<unix seconds>,v1=<hex>`, where
 * the hex is HMAC-SHA256 over `"<t>.<raw body>"` keyed by the endpoint secret.
 * Binding the timestamp into the MAC lets receivers reject replays; `v1` leaves
 * room to add a scheme without breaking old receivers.
 */

export const SIGNATURE_HEADER = 'ScormFlow-Signature';
export const EVENT_HEADER = 'ScormFlow-Event';
export const DELIVERY_HEADER = 'ScormFlow-Delivery';

/** Default replay window for {@link verifySignature}. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString('base64url')}`;
}

export function computeSignature(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export function signatureHeader(secret: string, body: string, now: Date = new Date()): string {
  const t = Math.floor(now.getTime() / 1000);
  return `t=${t},v1=${computeSignature(secret, t, body)}`;
}

/**
 * Check a signature header against the raw request body. Accepts any `v1` in
 * the header, so a receiver keeps working while the secret is mid-rotation.
 */
export function verifySignature(
  secret: string,
  header: string | undefined,
  body: string,
  options: { toleranceSeconds?: number; now?: Date } = {},
): boolean {
  if (!header) return false;
  let timestamp: number | undefined;
  const candidates: string[] = [];
  for (const part of header.split(',')) {
    const [key, value] = part.trim().split('=', 2);
    if (key === 't' && value) timestamp = Number(value);
    if (key === 'v1' && value) candidates.push(value);
  }
  if (timestamp === undefined || !Number.isFinite(timestamp) || candidates.length === 0) return false;

  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - timestamp) > tolerance) return false;

  const expected = Buffer.from(computeSignature(secret, timestamp, body), 'hex');
  return candidates.some((candidate) => {
    const actual = Buffer.from(candidate, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
}
