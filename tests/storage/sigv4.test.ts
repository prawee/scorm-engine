import { describe, expect, it } from 'vitest';

import { EMPTY_SHA256, amzDate, encodePath, presignUrl, sha256Hex, signRequest, uriEncode } from '../../src/storage/sigv4.js';

// Worked examples from the AWS docs ("Signature Calculations for the
// Authorization Header" / "Authenticating Requests: Using Query Parameters").
const ctx = {
  credentials: {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  },
  region: 'us-east-1',
  date: new Date('2013-05-24T00:00:00Z'),
};
const host = 'examplebucket.s3.amazonaws.com';

describe('SigV4 helpers', () => {
  it('formats the amz date', () => {
    expect(amzDate(ctx.date)).toBe('20130524T000000Z');
  });

  it('hashes the empty payload to the well-known constant', () => {
    expect(sha256Hex('')).toBe(EMPTY_SHA256);
  });

  it('encodes per RFC 3986, keeping slashes in paths', () => {
    expect(uriEncode("a b+c!'()*~")).toBe('a%20b%2Bc%21%27%28%29%2A~');
    expect(encodePath('tenants/t1/my file$.txt')).toBe('tenants/t1/my%20file%24.txt');
  });
});

describe('signRequest (AWS reference vectors)', () => {
  it('GET Object with a Range header', () => {
    const { url, headers } = signRequest(
      {
        method: 'GET',
        protocol: 'https:',
        host,
        path: '/test.txt',
        headers: { Range: 'bytes=0-9' },
        payloadHash: EMPTY_SHA256,
      },
      ctx,
    );
    expect(url).toBe('https://examplebucket.s3.amazonaws.com/test.txt');
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
    expect(headers).not.toHaveProperty('host');
    expect(headers['x-amz-date']).toBe('20130524T000000Z');
  });

  it('GET Bucket (list objects) with a query string', () => {
    const { url, headers } = signRequest(
      {
        method: 'GET',
        protocol: 'https:',
        host,
        path: '/',
        query: { prefix: 'J', 'max-keys': '2' },
        payloadHash: EMPTY_SHA256,
      },
      ctx,
    );
    expect(url).toBe('https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J');
    expect(headers.authorization).toContain(
      'Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7',
    );
  });

  it('adds the session token for temporary credentials', () => {
    const { headers } = signRequest(
      { method: 'GET', protocol: 'https:', host, path: '/a', payloadHash: EMPTY_SHA256 },
      { ...ctx, credentials: { ...ctx.credentials, sessionToken: 'tok' } },
    );
    expect(headers['x-amz-security-token']).toBe('tok');
    expect(headers.authorization).toContain('x-amz-security-token');
  });
});

describe('presignUrl (AWS reference vector)', () => {
  it('pre-signs a GET valid for a day', () => {
    const url = presignUrl({ method: 'GET', protocol: 'https:', host, path: '/test.txt' }, ctx, 86400);
    expect(url).toBe(
      'https://examplebucket.s3.amazonaws.com/test.txt' +
        '?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
        '&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request' +
        '&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host' +
        '&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );
  });
});
