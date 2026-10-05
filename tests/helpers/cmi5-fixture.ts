import AdmZip from 'adm-zip';

export const COURSE_IRI = 'https://example.com/cmi5/course';
export const AU1_IRI = 'https://example.com/cmi5/au/1';
export const AU2_IRI = 'https://example.com/cmi5/au/2';
export const BLOCK_IRI = 'https://example.com/cmi5/block/1';

export interface Cmi5FixtureOptions {
  au1Url?: string;
  au2Url?: string;
  au1MoveOn?: string;
  au2MoveOn?: string;
  masteryScore?: number;
}

/** A two-AU course: AU 1 at the top level, AU 2 inside a block. */
export function cmi5Xml(options: Cmi5FixtureOptions = {}): string {
  const mastery = options.masteryScore === undefined ? '' : ` masteryScore="${options.masteryScore}"`;
  return `<?xml version="1.0" encoding="utf-8"?>
<courseStructure xmlns="https://w3id.org/xapi/profiles/cmi5/v1/CourseStructure.xsd">
  <course id="${COURSE_IRI}">
    <title><langstring lang="en-US">Intro to cmi5</langstring></title>
    <description><langstring lang="en-US">A sample course</langstring></description>
  </course>
  <au id="${AU1_IRI}" moveOn="${options.au1MoveOn ?? 'CompletedAndPassed'}"${mastery}>
    <title><langstring lang="en-US">Lesson 1</langstring></title>
    <url>${options.au1Url ?? 'au1/index.html'}</url>
    <launchParameters>{"level":1}</launchParameters>
  </au>
  <block id="${BLOCK_IRI}">
    <title><langstring lang="en-US">Block 1</langstring></title>
    <au id="${AU2_IRI}" moveOn="${options.au2MoveOn ?? 'Completed'}" launchMethod="OwnWindow">
      <title><langstring lang="en-US">Lesson 2</langstring></title>
      <url>${options.au2Url ?? 'au2/index.html'}</url>
    </au>
  </block>
</courseStructure>`;
}

export function buildCmi5Zip(options: Cmi5FixtureOptions = {}): Buffer {
  const zip = new AdmZip();
  zip.addFile('cmi5.xml', Buffer.from(cmi5Xml(options), 'utf8'));
  zip.addFile('au1/index.html', Buffer.from('<html>lesson 1</html>', 'utf8'));
  zip.addFile('au2/index.html', Buffer.from('<html>lesson 2</html>', 'utf8'));
  return zip.toBuffer();
}

export function multipart(file: Buffer, filename = 'course.zip'): {
  payload: Buffer;
  headers: Record<string, string>;
} {
  const boundary = '----cmi5-boundary';
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        'Content-Type: application/octet-stream\r\n\r\n',
      'utf8',
    ),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}
