import { isIP } from 'node:net';

/**
 * Endpoint URL policy.
 *
 * Unless private URLs are allowed, an endpoint may not name localhost or a
 * private, loopback, link-local (cloud metadata) or unspecified address
 * literal. This is a registration-time guard against the obvious SSRF targets;
 * it does not resolve DNS, so a public name that resolves to a private address
 * gets through — deploy the engine with egress filtering if that matters.
 */

export class WebhookUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookUrlError';
  }
}

export function assertDeliverableUrl(raw: string, allowPrivate: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebhookUrlError('url must be an absolute URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new WebhookUrlError('url must use http or https');
  }
  if (url.username || url.password) {
    throw new WebhookUrlError('url must not embed credentials');
  }
  if (!allowPrivate && isPrivateHost(url.hostname)) {
    throw new WebhookUrlError(
      'url points at a private or loopback address; set WEBHOOK_ALLOW_PRIVATE_URLS=true to allow it',
    );
  }
  return url;
}

export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) return true;

  const family = isIP(host);
  if (family === 4) return isPrivateIpv4(host);
  if (family === 6) {
    if (host === '::' || host === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
    if (mapped) return isPrivateIpv4(mapped[1]!);
    // fc00::/7 unique local, fe80::/10 link-local
    return /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
  }
  return false;
}

function isPrivateIpv4(ip: string): boolean {
  const [a = 0, b = 0] = ip.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, incl. cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}
