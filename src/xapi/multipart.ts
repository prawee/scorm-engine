import { randomBytes } from 'node:crypto';

import { XapiError } from './errors.js';

/**
 * A minimal `multipart/mixed` codec (RFC 2046 §5.1), which is all xAPI needs to
 * carry statements together with their attachment bodies. Parts are kept as raw
 * buffers: attachment content is binary and must reach the hash check untouched.
 */

export interface MultipartPart {
  /** Header names are lower-cased. */
  headers: Record<string, string>;
  body: Buffer;
}

const CRLF = Buffer.from('\r\n');
const HEADER_END = Buffer.from('\r\n\r\n');

/** Pull the `boundary` parameter out of a `multipart/mixed` Content-Type. */
export function boundaryOf(contentType: string): string {
  const match = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary) {
    throw XapiError.badRequest('multipart/mixed request has no boundary', 'invalid_multipart');
  }
  return boundary;
}

export function parseMultipart(body: Buffer, boundary: string): MultipartPart[] {
  const delimiter = Buffer.from(`--${boundary}`);
  const separator = Buffer.concat([CRLF, delimiter]);
  const fail = (message: string): never => {
    throw XapiError.badRequest(`Malformed multipart body: ${message}`, 'invalid_multipart');
  };

  // Anything before the first delimiter is preamble and ignored.
  let pos = body.indexOf(delimiter);
  if (pos === -1) fail('boundary not found');
  pos += delimiter.length;

  const parts: MultipartPart[] = [];
  for (;;) {
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) return parts; // closing `--`

    // The rest of the delimiter line may carry transport padding.
    const lineEnd = body.indexOf(CRLF, pos);
    if (lineEnd === -1) fail('unterminated delimiter line');
    pos = lineEnd + CRLF.length;

    const next = body.indexOf(separator, pos);
    if (next === -1) fail('missing closing boundary');

    parts.push(splitPart(body.subarray(pos, next), fail));
    pos = next + separator.length;
  }
}

function splitPart(raw: Buffer, fail: (message: string) => never): MultipartPart {
  // A part with no headers starts straight with the blank line.
  if (raw.subarray(0, CRLF.length).equals(CRLF)) {
    return { headers: {}, body: raw.subarray(CRLF.length) };
  }
  const end = raw.indexOf(HEADER_END);
  if (end === -1) fail('part headers are not terminated');

  const headers: Record<string, string> = {};
  for (const line of raw.subarray(0, end).toString('latin1').split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) fail(`invalid header line ${JSON.stringify(line)}`);
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { headers, body: raw.subarray(end + HEADER_END.length) };
}

/** Serialise parts into a `multipart/mixed` body; returns the matching Content-Type. */
export function buildMultipart(parts: MultipartPart[]): { contentType: string; body: Buffer } {
  const boundary = `scormflow-${randomBytes(12).toString('hex')}`;
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const head = Object.entries(part.headers)
      .map(([name, value]) => `${name}: ${value}\r\n`)
      .join('');
    chunks.push(Buffer.from(`--${boundary}\r\n${head}\r\n`, 'latin1'), part.body, CRLF);
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    contentType: `multipart/mixed; boundary=${boundary}`,
    body: Buffer.concat(chunks),
  };
}
