import { describe, expect, it } from 'vitest';

import {
  computeSignature,
  generateWebhookSecret,
  signatureHeader,
  verifySignature,
} from '../../src/webhooks/signing.js';
import { assertDeliverableUrl, isPrivateHost, WebhookUrlError } from '../../src/webhooks/urls.js';

const SECRET = 'whsec_test';
const BODY = '{"id":"evt_1","type":"course.completed"}';
const NOW = new Date('2026-10-05T12:00:00Z');

describe('webhook signatures', () => {
  it('round-trips a signature over the timestamp and body', () => {
    const header = signatureHeader(SECRET, BODY, NOW);
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(verifySignature(SECRET, header, BODY, { now: NOW })).toBe(true);
  });

  it('rejects a tampered body, a wrong secret, and a missing header', () => {
    const header = signatureHeader(SECRET, BODY, NOW);
    expect(verifySignature(SECRET, header, `${BODY} `, { now: NOW })).toBe(false);
    expect(verifySignature('whsec_other', header, BODY, { now: NOW })).toBe(false);
    expect(verifySignature(SECRET, undefined, BODY, { now: NOW })).toBe(false);
    expect(verifySignature(SECRET, 't=abc,v1=00', BODY, { now: NOW })).toBe(false);
  });

  it('rejects signatures outside the replay window', () => {
    const header = signatureHeader(SECRET, BODY, NOW);
    const later = new Date(NOW.getTime() + 301_000);
    expect(verifySignature(SECRET, header, BODY, { now: later })).toBe(false);
    expect(verifySignature(SECRET, header, BODY, { now: later, toleranceSeconds: 600 })).toBe(true);
  });

  it('accepts any of several v1 values, for secret rotation', () => {
    const t = Math.floor(NOW.getTime() / 1000);
    const header = `t=${t},v1=${computeSignature('whsec_old', t, BODY)},v1=${computeSignature(SECRET, t, BODY)}`;
    expect(verifySignature(SECRET, header, BODY, { now: NOW })).toBe(true);
  });

  it('generates distinct, prefixed secrets', () => {
    const a = generateWebhookSecret();
    expect(a).toMatch(/^whsec_[A-Za-z0-9_-]{32}$/);
    expect(generateWebhookSecret()).not.toBe(a);
  });
});

describe('webhook URL policy', () => {
  it.each([
    'localhost',
    'api.localhost',
    'metadata.google.internal',
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '[::1]',
    '[fd00::1]',
    '[fe80::1]',
    '[::ffff:10.0.0.1]',
  ])('treats %s as private', (host) => {
    expect(isPrivateHost(host)).toBe(true);
  });

  it.each(['example.com', '8.8.8.8', '172.32.0.1', '[2001:db8::1]'])('treats %s as public', (host) => {
    expect(isPrivateHost(host)).toBe(false);
  });

  it('only accepts http(s) URLs without credentials, and private ones on request', () => {
    expect(assertDeliverableUrl('https://hooks.example.com/x', false).hostname).toBe('hooks.example.com');
    expect(() => assertDeliverableUrl('ftp://example.com', false)).toThrow(WebhookUrlError);
    expect(() => assertDeliverableUrl('not a url', false)).toThrow(WebhookUrlError);
    expect(() => assertDeliverableUrl('https://u:p@example.com', false)).toThrow(/credentials/);
    expect(() => assertDeliverableUrl('http://127.0.0.1:8080/hook', false)).toThrow(/private/);
    expect(assertDeliverableUrl('http://127.0.0.1:8080/hook', true).port).toBe('8080');
  });
});
