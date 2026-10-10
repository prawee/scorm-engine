import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  buildMultipart,
  loadAttachments,
  parseMultipart,
  parseStatementUpload,
  reconcileAttachments,
  saveAttachments,
  SIGNATURE_USAGE_TYPE,
  type AttachmentBody,
} from '../../src/xapi/index.js';
import { MemoryStorage } from '../helpers/memory-storage.js';
import { sampleStatement } from '../helpers/mock-lrs.js';

const TENANT = 'tenant_1';
const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

const TEXT = Buffer.from('certificate of completion');
const TEXT_SHA = sha256(TEXT);

function declared(sha2: string, extra: Record<string, unknown> = {}) {
  return {
    usageType: 'http://id.tincanapi.com/attachment/certificate-of-completion',
    display: { 'en-US': 'Certificate' },
    contentType: 'text/plain',
    length: TEXT.length,
    sha2,
    ...extra,
  };
}

function body(content: Buffer, contentType = 'text/plain'): AttachmentBody {
  return { sha2: sha256(content), contentType, content };
}

function upload(statements: unknown, parts: Array<{ headers: Record<string, string>; body: Buffer }>) {
  return buildMultipart([
    { headers: { 'Content-Type': 'application/json' }, body: Buffer.from(JSON.stringify(statements)) },
    ...parts,
  ]);
}

const binaryPart = (content: Buffer, hash = sha256(content)) => ({
  headers: {
    'Content-Type': 'text/plain',
    'Content-Transfer-Encoding': 'binary',
    'X-Experience-API-Hash': hash,
  },
  body: content,
});

describe('multipart codec', () => {
  it('round-trips binary parts', () => {
    const binary = Buffer.from([0, 13, 10, 45, 45, 255, 13, 10]);
    const built = buildMultipart([
      { headers: { 'Content-Type': 'application/json' }, body: Buffer.from('{"a":1}') },
      { headers: { 'X-Thing': 'yes' }, body: binary },
    ]);
    const boundary = /boundary=(.+)$/.exec(built.contentType)![1]!;
    const parts = parseMultipart(built.body, boundary);

    expect(parts).toHaveLength(2);
    expect(parts[0]!.headers['content-type']).toBe('application/json');
    expect(parts[0]!.body.toString()).toBe('{"a":1}');
    expect(parts[1]!.headers['x-thing']).toBe('yes');
    expect(parts[1]!.body.equals(binary)).toBe(true);
  });

  it('ignores a preamble and accepts a quoted boundary', () => {
    const raw = Buffer.from(
      'preamble\r\n--b1\r\nContent-Type: application/json\r\n\r\n[]\r\n--b1--\r\n',
    );
    const result = parseStatementUpload(raw, 'multipart/mixed; boundary="b1"');
    expect(result).toEqual({ body: [], attachments: [] });
  });

  it('rejects a body with no closing boundary', () => {
    const raw = Buffer.from('--b1\r\nContent-Type: application/json\r\n\r\n[]');
    expect(() => parseStatementUpload(raw, 'multipart/mixed; boundary=b1')).toThrow(/closing boundary/);
  });

  it('rejects a request without a boundary', () => {
    expect(() => parseStatementUpload(Buffer.from(''), 'multipart/mixed')).toThrow(/no boundary/);
  });
});

describe('parseStatementUpload', () => {
  it('separates statements from verified attachment bodies', () => {
    const statement = sampleStatement({ attachments: [declared(TEXT_SHA)] });
    const built = upload(statement, [binaryPart(TEXT)]);

    const result = parseStatementUpload(built.body, built.contentType);

    expect(result.body).toEqual(statement);
    expect(result.attachments).toEqual([
      { sha2: TEXT_SHA, contentType: 'text/plain', content: TEXT },
    ]);
  });

  it('requires the first part to be JSON', () => {
    const built = buildMultipart([binaryPart(TEXT)]);
    expect(() => parseStatementUpload(built.body, built.contentType)).toThrow(/application\/json/);
  });

  it('rejects a part whose content does not match its hash', () => {
    const built = upload(sampleStatement(), [binaryPart(TEXT, sha256('something else'))]);
    expect(() => parseStatementUpload(built.body, built.contentType)).toThrow(
      expect.objectContaining({ code: 'attachment_hash_mismatch' }),
    );
  });

  it('requires binary transfer encoding and a hash header', () => {
    const noEncoding = upload(sampleStatement(), [
      { headers: { 'X-Experience-API-Hash': TEXT_SHA }, body: TEXT },
    ]);
    expect(() => parseStatementUpload(noEncoding.body, noEncoding.contentType)).toThrow(/binary/);

    const noHash = upload(sampleStatement(), [
      { headers: { 'Content-Transfer-Encoding': 'binary' }, body: TEXT },
    ]);
    expect(() => parseStatementUpload(noHash.body, noHash.contentType)).toThrow(/X-Experience-API-Hash/);
  });

  it('accepts SHA-512 digests', () => {
    const sha512 = createHash('sha512').update(TEXT).digest('hex');
    const built = upload(sampleStatement(), [binaryPart(TEXT, sha512)]);
    expect(parseStatementUpload(built.body, built.contentType).attachments[0]!.sha2).toBe(sha512);
  });
});

describe('reconcileAttachments', () => {
  it('passes when every declared attachment has a body', () => {
    expect(() =>
      reconcileAttachments([sampleStatement({ attachments: [declared(TEXT_SHA)] })], [body(TEXT)]),
    ).not.toThrow();
  });

  it('lets a fileUrl attachment travel without a body', () => {
    const statement = sampleStatement({
      attachments: [declared('ab'.repeat(32), { fileUrl: 'https://example.com/cert.pdf' })],
    });
    expect(() => reconcileAttachments([statement], [])).not.toThrow();
  });

  it('rejects a declared attachment whose body is missing', () => {
    expect(() =>
      reconcileAttachments([sampleStatement({ attachments: [declared(TEXT_SHA)] })], []),
    ).toThrow(expect.objectContaining({ code: 'missing_attachment' }));
  });

  it('rejects a body no statement declares', () => {
    expect(() => reconcileAttachments([sampleStatement()], [body(TEXT)])).toThrow(
      expect.objectContaining({ code: 'unexpected_attachment' }),
    );
  });

  it('matches hashes case-insensitively', () => {
    const statement = sampleStatement({ attachments: [declared(TEXT_SHA.toUpperCase())] });
    expect(() => reconcileAttachments([statement], [body(TEXT)])).not.toThrow();
  });
});

describe('statement signatures', () => {
  function signed(payload: unknown, header: Record<string, unknown> = { alg: 'RS256' }) {
    const jws = Buffer.from(`${b64url(header)}.${b64url(payload)}.c2lnbmF0dXJl`);
    const statement = sampleStatement({
      attachments: [
        declared(sha256(jws), {
          usageType: SIGNATURE_USAGE_TYPE,
          contentType: 'application/octet-stream',
          length: jws.length,
        }),
      ],
    });
    return { statement, bodies: [body(jws, 'application/octet-stream')] };
  }

  it('accepts a JWS whose payload is the statement', () => {
    const { statement, bodies } = signed(sampleStatement());
    expect(() => reconcileAttachments([statement], bodies)).not.toThrow();
  });

  it('rejects a JWS whose payload differs from the statement', () => {
    const { statement, bodies } = signed(sampleStatement({ object: { id: 'http://example.com/other' } }));
    expect(() => reconcileAttachments([statement], bodies)).toThrow(/does not match/);
  });

  it('rejects an unsupported algorithm', () => {
    const { statement, bodies } = signed(sampleStatement(), { alg: 'HS256' });
    expect(() => reconcileAttachments([statement], bodies)).toThrow(/RS256/);
  });

  it('rejects a signature that does not verify against its x5c certificate', () => {
    const { statement, bodies } = signed(sampleStatement(), { alg: 'RS256', x5c: ['bm90IGEgY2VydA=='] });
    expect(() => reconcileAttachments([statement], bodies)).toThrow(/x5c/);
  });

  it('requires the signature body to be sent', () => {
    const { statement } = signed(sampleStatement());
    expect(() => reconcileAttachments([statement], [])).toThrow(
      expect.objectContaining({ code: 'missing_attachment' }),
    );
  });
});

describe('attachment storage', () => {
  it('stores bodies under the tenant prefix and loads them for statements', async () => {
    const storage = new MemoryStorage();
    await saveAttachments(TENANT, [body(TEXT)], storage);

    expect([...storage.files.keys()]).toEqual([`tenants/${TENANT}/xapi-attachments/${TEXT_SHA}`]);

    const loaded = await loadAttachments(
      TENANT,
      [
        sampleStatement({ attachments: [declared(TEXT_SHA)] }),
        sampleStatement({ attachments: [declared(TEXT_SHA)] }),
        sampleStatement({ attachments: [declared('cd'.repeat(32), { fileUrl: 'https://x/y' })] }),
      ],
      storage,
    );
    expect(loaded).toEqual([{ sha2: TEXT_SHA, contentType: 'text/plain', content: TEXT }]);
  });

  it('does not leak bodies across tenants', async () => {
    const storage = new MemoryStorage();
    await saveAttachments(TENANT, [body(TEXT)], storage);
    const loaded = await loadAttachments(
      'tenant_2',
      [sampleStatement({ attachments: [declared(TEXT_SHA)] })],
      storage,
    );
    expect(loaded).toEqual([]);
  });
});
