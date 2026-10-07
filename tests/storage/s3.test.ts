import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { S3Error, S3Storage } from '../../src/storage/s3.js';
import { createStorage } from '../../src/storage/index.js';
import { PrefixedStorage } from '../../src/storage/scoped.js';
import { StorageNotFoundError } from '../../src/storage/types.js';
import { createTestEnv } from '../helpers/test-env.js';
import { FakeS3 } from '../helpers/fake-s3.js';

const MiB = 1024 * 1024;
const creds = { region: 'us-east-1', accessKeyId: 'AKID', secretAccessKey: 'secret' };

function pathStyle(partSize?: number) {
  const s3 = new FakeS3('course-bucket', { pathStyle: true, baseHost: 'minio.local:9000' });
  const storage = new S3Storage({
    ...creds,
    bucket: 'course-bucket',
    endpoint: 'http://minio.local:9000',
    forcePathStyle: true,
    fetch: s3.fetch,
    now: () => new Date('2026-10-07T12:00:00Z'),
    ...(partSize ? { partSize } : {}),
  });
  return { s3, storage };
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks);
}

describe('S3Storage', () => {
  it('puts, gets and checks objects (path style)', async () => {
    const { s3, storage } = pathStyle();
    await storage.put('tenants/t1/courses/c1/index.html', Buffer.from('<h1>hi</h1>'));
    expect(s3.objects.get('tenants/t1/courses/c1/index.html')?.toString()).toBe('<h1>hi</h1>');

    expect((await readAll(await storage.get('tenants/t1/courses/c1/index.html'))).toString()).toBe('<h1>hi</h1>');
    expect(await storage.exists('tenants/t1/courses/c1/index.html')).toBe(true);
    // A prefix with objects beneath it "exists", like a directory on the local driver.
    expect(await storage.exists('tenants/t1/courses/c1')).toBe(true);
    expect(await storage.exists('tenants/t1/courses/c2')).toBe(false);
  });

  it('addresses the bucket as a subdomain by default', async () => {
    const s3 = new FakeS3('b1', { pathStyle: false, baseHost: 's3.eu-west-1.amazonaws.com' });
    const storage = new S3Storage({ ...creds, region: 'eu-west-1', bucket: 'b1', fetch: s3.fetch });
    await storage.put('a/b.txt', Buffer.from('x'));
    expect(s3.objects.has('a/b.txt')).toBe(true);
    await storage.check();
  });

  it('encodes awkward keys', async () => {
    const { s3, storage } = pathStyle();
    const key = 'tenants/t1/courses/c1/media/intro video (final) & more+.mp4';
    await storage.put(key, Buffer.from('v'));
    expect(s3.objects.has(key)).toBe(true);
    expect((await readAll(await storage.get(key))).toString()).toBe('v');
  });

  it('throws StorageNotFoundError for missing objects', async () => {
    const { storage } = pathStyle();
    await expect(storage.get('tenants/t1/nope.txt')).rejects.toBeInstanceOf(StorageNotFoundError);
    await expect(storage.signedUrl('tenants/t1/nope.txt', 60)).rejects.toBeInstanceOf(StorageNotFoundError);
  });

  it('streams small uploads as a single PUT', async () => {
    const { s3, storage } = pathStyle();
    await storage.put('k/small.bin', Readable.from([Buffer.from('ab'), Buffer.from('cd')]));
    expect(s3.objects.get('k/small.bin')?.toString()).toBe('abcd');
    expect(s3.calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
  });

  it('switches to multipart upload for large streams', async () => {
    const { s3, storage } = pathStyle(5 * MiB);
    const big = Buffer.alloc(11 * MiB + 123);
    for (let i = 0; i < big.length; i += 4096) big[i] = i % 251;
    // Feed it in odd-sized chunks so parts straddle chunk boundaries.
    const chunks: Buffer[] = [];
    for (let i = 0; i < big.length; i += 700_001) chunks.push(big.subarray(i, i + 700_001));
    await storage.put('k/big.bin', Readable.from(chunks));

    expect(s3.objects.get('k/big.bin')?.equals(big)).toBe(true);
    const partCalls = s3.calls.filter((c) => c.method === 'PUT' && c.query.partNumber);
    expect(partCalls.map((c) => c.query.partNumber)).toEqual(['1', '2', '3']);
    expect(s3.uploads.size).toBe(0);
  });

  it('aborts the multipart upload when the source stream fails', async () => {
    const { s3, storage } = pathStyle(5 * MiB);
    async function* failing() {
      yield Buffer.alloc(6 * MiB);
      throw new Error('disk on fire');
    }
    await expect(storage.put('k/broken.bin', Readable.from(failing()))).rejects.toThrow('disk on fire');
    expect(s3.uploads.size).toBe(0);
    expect(s3.calls.some((c) => c.method === 'DELETE' && c.query.uploadId)).toBe(true);
    expect(s3.objects.has('k/broken.bin')).toBe(false);
  });

  it('deletes an object and everything beneath it, across list pages', async () => {
    const { s3, storage } = pathStyle();
    for (const f of ['a.html', 'b.js', 'img/c.png', 'img/d.png', 'e.css']) {
      await storage.put(`tenants/t1/courses/c1/${f}`, Buffer.from(f));
    }
    await storage.put('tenants/t1/courses/c10/keep.html', Buffer.from('keep'));
    await storage.put('tenants/t1/courses/c1', Buffer.from('odd but legal'));

    await storage.delete('tenants/t1/courses/c1');
    expect([...s3.objects.keys()]).toEqual(['tenants/t1/courses/c10/keep.html']);
    expect(s3.calls.filter((c) => c.query['list-type'] === '2').length).toBeGreaterThan(1);
  });

  it('pre-signs GET URLs, capping the TTL at 7 days', async () => {
    const { storage } = pathStyle();
    await storage.put('tenants/t1/x.pdf', Buffer.from('%PDF'));
    const url = new URL(await storage.signedUrl('tenants/t1/x.pdf', 30 * 24 * 3600));
    expect(url.origin).toBe('http://minio.local:9000');
    expect(url.pathname).toBe('/course-bucket/tenants/t1/x.pdf');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('604800');
    expect(url.searchParams.get('X-Amz-Credential')).toBe('AKID/20261007/us-east-1/s3/aws4_request');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('surfaces S3 error codes', async () => {
    const { s3, storage } = pathStyle();
    s3.failWith = { method: 'PUT', status: 403, code: 'AccessDenied' };
    const err = await storage.put('k/x', Buffer.from('x')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(S3Error);
    expect(err).toMatchObject({ status: 403, code: 'AccessDenied' });

    s3.failWith = { method: 'HEAD', status: 403, code: 'AccessDenied' };
    await expect(storage.check()).rejects.toBeInstanceOf(S3Error);
  });

  it('rejects traversal and empty keys', async () => {
    const { storage } = pathStyle();
    await expect(storage.get('a/../b')).rejects.toThrow(/Invalid storage key/);
    await expect(storage.put('/', Buffer.from(''))).rejects.toThrow(/Invalid storage key/);
  });

  it('refuses part sizes below the S3 minimum', () => {
    expect(() => new S3Storage({ ...creds, bucket: 'b', partSize: MiB })).toThrow(/partSize/);
  });

  it('works under a deployment STORAGE_PREFIX', async () => {
    const { s3, storage } = pathStyle();
    const prefixed = new PrefixedStorage(storage, 'prod/eu-1');
    await prefixed.put('tenants/t1/a.txt', Buffer.from('a'));
    expect([...s3.objects.keys()]).toEqual(['prod/eu-1/tenants/t1/a.txt']);
    await prefixed.check?.();
  });
});

describe('createStorage with STORAGE_DRIVER=s3', () => {
  it('builds an S3Storage from env', () => {
    const storage = createStorage(
      createTestEnv({
        STORAGE_DRIVER: 's3',
        S3_REGION: 'auto',
        S3_BUCKET: 'b',
        S3_ACCESS_KEY_ID: 'k',
        S3_SECRET_ACCESS_KEY: 's',
        S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
      }),
    );
    expect(storage).toBeInstanceOf(S3Storage);
  });
});
