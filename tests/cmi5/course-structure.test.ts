import { describe, expect, it } from 'vitest';

import { CourseStructureError, parseCourseStructure } from '../../src/cmi5/course-structure.js';
import { AU1_IRI, AU2_IRI, COURSE_IRI, cmi5Xml } from '../helpers/cmi5-fixture.js';

describe('parseCourseStructure', () => {
  it('reads the course, its AUs, and the block tree in document order', () => {
    const parsed = parseCourseStructure(cmi5Xml({ masteryScore: 0.8 }));

    expect(parsed.id).toBe(COURSE_IRI);
    expect(parsed.title).toBe('Intro to cmi5');
    expect(parsed.description).toBe('A sample course');
    expect(parsed.aus.map((au) => au.id)).toEqual([AU1_IRI, AU2_IRI]);

    const [au1, au2] = parsed.aus;
    expect(au1).toMatchObject({
      title: 'Lesson 1',
      url: 'au1/index.html',
      moveOn: 'CompletedAndPassed',
      masteryScore: 0.8,
      launchMethod: 'AnyWindow',
      launchParameters: '{"level":1}',
    });
    expect(au2).toMatchObject({ moveOn: 'Completed', launchMethod: 'OwnWindow', masteryScore: null });

    expect(parsed.children).toEqual([
      { type: 'au', id: AU1_IRI },
      {
        type: 'block',
        id: 'https://example.com/cmi5/block/1',
        title: 'Block 1',
        description: null,
        children: [{ type: 'au', id: AU2_IRI }],
      },
    ]);
  });

  it.each([
    ['not XML at all <', 'malformed_xml'],
    ['<courseStructure><au id="x:y"><url>a</url></au></courseStructure>', 'missing_course'],
    [`<courseStructure><course id="${COURSE_IRI}"/></courseStructure>`, 'no_aus'],
  ])('rejects %s', (xml, code) => {
    expect(() => parseCourseStructure(xml)).toThrow(CourseStructureError);
    try {
      parseCourseStructure(xml);
    } catch (err) {
      expect((err as CourseStructureError).code).toBe(code);
    }
  });

  it('rejects an AU with an invalid moveOn or masteryScore', () => {
    expect(() => parseCourseStructure(cmi5Xml({ au1MoveOn: 'Whenever' }))).toThrow(/moveOn/);
    expect(() => parseCourseStructure(cmi5Xml({ masteryScore: 80 }))).toThrow(/masteryScore/);
  });

  it('rejects duplicate AU ids', () => {
    const xml = cmi5Xml().replace(AU2_IRI, AU1_IRI);
    expect(() => parseCourseStructure(xml)).toThrow(/more than once/);
  });
});
