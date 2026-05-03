// Per-type response-shape tests. These guard against the v11/iteration-1
// bug class: silently returning empty arrays when the actual lua-api
// response shape doesn't match a generic envelope assumption.
//
// Each test simulates the exact response shape from packages/lua-api/src/dto/.

import { describe, test, expect } from '@jest/globals';
import {
  extractList,
  extractVersions,
  SUPPORTED_LIST_TYPES,
  SUPPORTED_VERSION_TYPES,
} from '../src/response-shapes.mjs';

describe('extractList', () => {
  test('skill: { skills: [...] } (no envelope)', () => {
    expect(extractList('skill', { skills: [{ name: 'a' }, { name: 'b' }] }))
      .toEqual([{ name: 'a' }, { name: 'b' }]);
  });

  test('webhook: { success, data: { webhooks: [...] } }', () => {
    expect(extractList('webhook', { success: true, data: { webhooks: [{ name: 'w1' }] } }))
      .toEqual([{ name: 'w1' }]);
  });

  test('job: { success, data: { jobs: [...] } }', () => {
    expect(extractList('job', { success: true, data: { jobs: [{ name: 'j1' }] } }))
      .toEqual([{ name: 'j1' }]);
  });

  test('preprocessor: { success, data: { preprocessors: [...] } }', () => {
    expect(extractList('preprocessor', { success: true, data: { preprocessors: [{ name: 'p1' }] } }))
      .toEqual([{ name: 'p1' }]);
  });

  test('postprocessor: { success, data: { postprocessors: [...] } }', () => {
    expect(extractList('postprocessor', { success: true, data: { postprocessors: [{ name: 'p1' }] } }))
      .toEqual([{ name: 'p1' }]);
  });

  test('returns [] when response is missing the expected key', () => {
    expect(extractList('webhook', { success: true })).toEqual([]);
    expect(extractList('skill', {})).toEqual([]);
    expect(extractList('job', null)).toEqual([]);
  });

  test('throws on unknown type', () => {
    expect(() => extractList('mcp', {})).toThrow(/unknown primitive type "mcp"/);
  });

  test('SUPPORTED_LIST_TYPES exposes the 5 types with list endpoints', () => {
    expect(SUPPORTED_LIST_TYPES).toEqual([
      'skill', 'webhook', 'job', 'preprocessor', 'postprocessor',
    ]);
  });
});

describe('extractVersions', () => {
  test('skill: { versions: [...] } (no envelope)', () => {
    expect(extractVersions('skill', { versions: [{ version: '1.0.0' }] }))
      .toEqual([{ version: '1.0.0' }]);
  });

  test('webhook: { success, data: { versions: [...] } }', () => {
    expect(extractVersions('webhook', { success: true, data: { versions: [{ version: '1.0.0' }] } }))
      .toEqual([{ version: '1.0.0' }]);
  });

  test('job: { success, data: JobVersionDto[] } — array DIRECTLY under data', () => {
    // This is the bug-prone shape — every other type wraps in an object.
    expect(extractVersions('job', { success: true, data: [{ version: '1.0.0' }, { version: '1.0.1' }] }))
      .toEqual([{ version: '1.0.0' }, { version: '1.0.1' }]);
  });

  test('job: returns [] when data is not an array', () => {
    expect(extractVersions('job', { success: true, data: { versions: [] } })).toEqual([]);
    expect(extractVersions('job', { success: false })).toEqual([]);
  });

  test('preprocessor: { success, data: { versions, activeVersionId? } }', () => {
    expect(extractVersions('preprocessor', { success: true, data: { versions: [{ version: '1.0.0' }], activeVersionId: 'v1' } }))
      .toEqual([{ version: '1.0.0' }]);
  });

  test('postprocessor: { success, data: { versions, activeVersionId? } }', () => {
    expect(extractVersions('postprocessor', { success: true, data: { versions: [{ version: '1.0.0' }] } }))
      .toEqual([{ version: '1.0.0' }]);
  });

  test('persona: { status, message, versions: [...] } (no envelope, status field instead of success)', () => {
    expect(extractVersions('persona', { status: 'ok', message: 'ok', versions: [{ version: '1.0.0' }] }))
      .toEqual([{ version: '1.0.0' }]);
  });

  test('returns [] when response is missing the expected key', () => {
    expect(extractVersions('skill', {})).toEqual([]);
    expect(extractVersions('webhook', { success: true })).toEqual([]);
    expect(extractVersions('preprocessor', { success: true, data: {} })).toEqual([]);
    expect(extractVersions('persona', null)).toEqual([]);
  });

  test('throws on unknown type', () => {
    expect(() => extractVersions('mcp', {})).toThrow(/unknown primitive type "mcp"/);
  });

  test('SUPPORTED_VERSION_TYPES exposes the 6 types with versions endpoints', () => {
    expect(SUPPORTED_VERSION_TYPES).toEqual([
      'skill', 'webhook', 'job', 'preprocessor', 'postprocessor', 'persona',
    ]);
  });
});
