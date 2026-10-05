import { XMLParser } from 'fast-xml-parser';

import {
  LAUNCH_METHODS,
  MOVE_ON,
  type LaunchMethod,
  type MoveOn,
} from './constants.js';

/**
 * Parser for the cmi5 course structure (`cmi5.xml`).
 *
 * Unlike `imsmanifest.xml`, sibling order matters here — `<au>` and `<block>`
 * elements interleave and their document order is the course order — so the
 * XML is parsed with `preserveOrder` and normalised into a small element tree
 * before anything is read out of it.
 */

export class CourseStructureError extends Error {
  constructor(
    message: string,
    public readonly code: 'malformed_xml' | 'missing_course' | 'no_aus' | 'invalid_au',
  ) {
    super(message);
    this.name = 'CourseStructureError';
  }
}

export interface ParsedAu {
  /** Publisher id (IRI) from the course structure. */
  id: string;
  title: string;
  description: string | null;
  url: string;
  launchMethod: LaunchMethod;
  moveOn: MoveOn;
  /** Scaled score in [0, 1], or null. */
  masteryScore: number | null;
  activityType: string | null;
  launchParameters: string | null;
  entitlementKey: string | null;
}

export interface ParsedBlock {
  id: string;
  /**
   * LMS-generated activity IRI, the object of the block's `satisfied`
   * statement. Assigned at import; absent straight out of the parser.
   */
  activityId?: string;
  title: string;
  description: string | null;
  /** AU and block children, in document order. */
  children: StructureNode[];
}

export type StructureNode = { type: 'au'; id: string } | ({ type: 'block' } & ParsedBlock);

export interface ParsedCourseStructure {
  /** Publisher id (IRI) of the course. */
  id: string;
  title: string;
  description: string | null;
  /** Every AU in the course, flattened in document order. */
  aus: ParsedAu[];
  /** Top-level AU and block children, in document order. */
  children: StructureNode[];
}

interface Element {
  name: string;
  attrs: Record<string, string>;
  children: Element[];
  text: string;
}

const xmlParser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  removeNSPrefix: true,
});

const IRI = /^[a-zA-Z][a-zA-Z0-9+.-]*:\S*$/;

export function parseCourseStructure(xml: string): ParsedCourseStructure {
  let raw: unknown;
  try {
    raw = xmlParser.parse(xml);
  } catch (err) {
    throw new CourseStructureError(
      `cmi5.xml is not well-formed XML: ${(err as Error).message}`,
      'malformed_xml',
    );
  }

  const root = toElements(raw).find((el) => el.name === 'courseStructure');
  if (!root) {
    throw new CourseStructureError('cmi5.xml has no <courseStructure> root element', 'malformed_xml');
  }

  const course = root.children.find((el) => el.name === 'course');
  const courseId = course?.attrs.id?.trim();
  if (!course || !courseId) {
    throw new CourseStructureError('cmi5.xml has no <course> element with an id', 'missing_course');
  }

  const aus: ParsedAu[] = [];
  const seen = new Set<string>();
  const children = readChildren(root, aus, seen);

  if (aus.length === 0) {
    throw new CourseStructureError('cmi5.xml declares no <au> elements', 'no_aus');
  }

  return {
    id: courseId,
    title: langString(course, 'title') ?? courseId,
    description: langString(course, 'description'),
    aus,
    children,
  };
}

function readChildren(parent: Element, aus: ParsedAu[], seen: Set<string>): StructureNode[] {
  const out: StructureNode[] = [];
  for (const el of parent.children) {
    if (el.name === 'au') {
      const au = readAu(el);
      if (seen.has(au.id)) {
        throw new CourseStructureError(`AU id ${au.id} appears more than once`, 'invalid_au');
      }
      seen.add(au.id);
      aus.push(au);
      out.push({ type: 'au', id: au.id });
    } else if (el.name === 'block') {
      const id = el.attrs.id?.trim();
      if (!id) throw new CourseStructureError('A <block> is missing its id', 'invalid_au');
      out.push({
        type: 'block',
        id,
        title: langString(el, 'title') ?? id,
        description: langString(el, 'description'),
        children: readChildren(el, aus, seen),
      });
    }
  }
  return out;
}

function readAu(el: Element): ParsedAu {
  const id = el.attrs.id?.trim();
  if (!id || !IRI.test(id)) {
    throw new CourseStructureError('Every <au> needs an id that is an absolute IRI', 'invalid_au');
  }

  const url = childText(el, 'url');
  if (!url) {
    throw new CourseStructureError(`AU ${id} has no <url>`, 'invalid_au');
  }

  const moveOn = (el.attrs.moveOn ?? 'NotApplicable') as MoveOn;
  if (!MOVE_ON.includes(moveOn)) {
    throw new CourseStructureError(`AU ${id} has an invalid moveOn "${moveOn}"`, 'invalid_au');
  }

  const launchMethod = (el.attrs.launchMethod ?? 'AnyWindow') as LaunchMethod;
  if (!LAUNCH_METHODS.includes(launchMethod)) {
    throw new CourseStructureError(
      `AU ${id} has an invalid launchMethod "${launchMethod}"`,
      'invalid_au',
    );
  }

  let masteryScore: number | null = null;
  if (el.attrs.masteryScore !== undefined) {
    masteryScore = Number(el.attrs.masteryScore);
    if (!Number.isFinite(masteryScore) || masteryScore < 0 || masteryScore > 1) {
      throw new CourseStructureError(
        `AU ${id} masteryScore must be a decimal between 0 and 1`,
        'invalid_au',
      );
    }
  }

  return {
    id,
    title: langString(el, 'title') ?? id,
    description: langString(el, 'description'),
    url,
    launchMethod,
    moveOn,
    masteryScore,
    activityType: el.attrs.activityType?.trim() || null,
    launchParameters: childText(el, 'launchParameters'),
    entitlementKey: childText(el, 'entitlementKey'),
  };
}

/** First `<langstring>` under a `<title>` / `<description>` child (or its bare text). */
function langString(el: Element, name: string): string | null {
  const child = el.children.find((c) => c.name === name);
  if (!child) return null;
  const first = child.children.find((c) => c.name === 'langstring');
  return (first ? first.text : child.text) || null;
}

function childText(el: Element, name: string): string | null {
  return el.children.find((c) => c.name === name)?.text || null;
}

/** Normalise fast-xml-parser's `preserveOrder` output into a plain element tree. */
function toElements(nodes: unknown): Element[] {
  if (!Array.isArray(nodes)) return [];
  const out: Element[] = [];
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    const record = node as Record<string, unknown>;
    const name = Object.keys(record).find((k) => k !== ':@' && k !== '#text');
    if (!name) continue;
    const body = record[name];
    const attrs = (record[':@'] as Record<string, string> | undefined) ?? {};
    const parts = Array.isArray(body) ? body : [];
    const text = parts
      .map((p) => (p as Record<string, unknown>)['#text'])
      .filter((t) => t !== undefined)
      .join('')
      .trim();
    out.push({ name, attrs, children: toElements(parts), text });
  }
  return out;
}
