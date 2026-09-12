// Per-type response-shape tests. These guard against silently returning
// empty arrays (or `active: false` for everything) when the actual lua-api
// response shape doesn't match a generic envelope assumption.
//
// Each fixture mirrors the exact DTO from packages/lua-api/src/dto/ or
// packages/lua-cli/src/interfaces/workflows.ts.

import { describe, test, expect } from '@jest/globals';
import {
  extractList,
  extractVersions,
  extractActiveVersionId,
  isActiveVersion,
  versionCreatedAt,
  versionId,
  LIST_PATHS,
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

  test('trigger: { success, data: { triggers: [...] } } (TriggersResponseDto)', () => {
    expect(extractList('trigger', { success: true, data: { triggers: [{ name: 't1' }] } }))
      .toEqual([{ name: 't1' }]);
  });

  test('preprocessor: { success, data: { preprocessors: [...] } }', () => {
    expect(extractList('preprocessor', { success: true, data: { preprocessors: [{ name: 'p1' }] } }))
      .toEqual([{ name: 'p1' }]);
  });

  test('postprocessor: { success, data: { postprocessors: [...] } }', () => {
    expect(extractList('postprocessor', { success: true, data: { postprocessors: [{ name: 'p1' }] } }))
      .toEqual([{ name: 'p1' }]);
  });

  test('workflow: { success, data: { workflows: [...] } } (R15)', () => {
    expect(extractList('workflow', { success: true, data: { workflows: [{ name: 'outreach' }] } }))
      .toEqual([{ name: 'outreach' }]);
  });

  test('returns [] when response is missing the expected key', () => {
    expect(extractList('webhook', { success: true })).toEqual([]);
    expect(extractList('skill', {})).toEqual([]);
    expect(extractList('job', null)).toEqual([]);
  });

  test('throws on unknown type', () => {
    expect(() => extractList('mcp', {})).toThrow(/unknown primitive type "mcp"/);
  });

  test('SUPPORTED_LIST_TYPES exposes the 7 types with list + versions routes', () => {
    expect(SUPPORTED_LIST_TYPES).toEqual([
      'skill', 'webhook', 'job', 'trigger', 'preprocessor', 'postprocessor', 'workflow',
    ]);
    expect(Object.keys(LIST_PATHS)).toEqual(SUPPORTED_LIST_TYPES);
    expect(LIST_PATHS.trigger).toBe('triggers');
    expect(LIST_PATHS.workflow).toBe('workflows');
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
    expect(extractVersions('job', { success: true, data: [{ version: '1.0.0' }, { version: '1.0.1' }] }))
      .toEqual([{ version: '1.0.0' }, { version: '1.0.1' }]);
  });

  test('job: returns [] when data is not an array', () => {
    expect(extractVersions('job', { success: true, data: { versions: [] } })).toEqual([]);
    expect(extractVersions('job', { success: false })).toEqual([]);
  });

  test('trigger: { success, data: { versions, activeVersionId? } } (TriggerVersionsResponseDto)', () => {
    expect(extractVersions('trigger', { success: true, data: { versions: [{ version: '1.0.0', versionId: 'tv1' }], activeVersionId: 'tv1' } }))
      .toEqual([{ version: '1.0.0', versionId: 'tv1' }]);
  });

  test('preprocessor / postprocessor: { success, data: { versions, activeVersionId? } }', () => {
    expect(extractVersions('preprocessor', { success: true, data: { versions: [{ version: '1.0.0' }], activeVersionId: 'v1' } }))
      .toEqual([{ version: '1.0.0' }]);
    expect(extractVersions('postprocessor', { success: true, data: { versions: [{ version: '1.0.0' }] } }))
      .toEqual([{ version: '1.0.0' }]);
  });

  test('workflow: { success, data: WorkflowVersion[] } — array DIRECTLY under data', () => {
    expect(extractVersions('workflow', { success: true, data: [{ version: '1.0.0', active: true }] }))
      .toEqual([{ version: '1.0.0', active: true }]);
    expect(extractVersions('workflow', { success: true, data: { versions: [] } })).toEqual([]);
  });

  test('persona: { status, message, versions: [...] } (no envelope, status field instead of success)', () => {
    expect(extractVersions('persona', { status: 'ok', message: 'ok', versions: [{ version: 1 }] }))
      .toEqual([{ version: 1 }]);
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

  test('SUPPORTED_VERSION_TYPES exposes the 8 types with versions endpoints', () => {
    expect(SUPPORTED_VERSION_TYPES).toEqual([
      'skill', 'webhook', 'job', 'trigger', 'preprocessor', 'postprocessor', 'workflow', 'persona',
    ]);
  });
});

describe('isActiveVersion — the live flag is spelled differently per family', () => {
  test('skill and persona use isCurrent (SkillVersionDto / PersonaVersionDto)', () => {
    expect(isActiveVersion('skill', { version: '1.0.0', isCurrent: true })).toBe(true);
    expect(isActiveVersion('skill', { version: '1.0.0', isCurrent: false })).toBe(false);
    expect(isActiveVersion('persona', { version: 3, isCurrent: true })).toBe(true);
  });

  test('job and workflow use active (JobVersionDto / WorkflowVersion)', () => {
    expect(isActiveVersion('job', { version: '1.0.0', active: true })).toBe(true);
    expect(isActiveVersion('job', { version: '1.0.0', active: false })).toBe(false);
    expect(isActiveVersion('workflow', { version: '2.0.0', active: true })).toBe(true);
  });

  test('webhook / trigger / processors use isActive, or activeVersionId on the envelope', () => {
    expect(isActiveVersion('webhook', { version: '1.0.0', isActive: true })).toBe(true);
    expect(isActiveVersion('webhook', { version: '1.0.0', isActive: false })).toBe(false);
    const envelope = { success: true, data: { versions: [], activeVersionId: 'pv_2' } };
    expect(isActiveVersion('preprocessor', { version: '1.0.1', versionId: 'pv_2' }, envelope)).toBe(true);
    expect(isActiveVersion('preprocessor', { version: '1.0.0', versionId: 'pv_1' }, envelope)).toBe(false);
    expect(isActiveVersion('trigger', { version: '1.0.0', versionId: 'tv_9' }, { data: { activeVersionId: 'tv_9' } })).toBe(true);
    expect(isActiveVersion('postprocessor', { version: '1.0.0', id: 'x_1' }, { data: { activeVersionId: 'x_1' } })).toBe(true);
  });

  test('deployedAt is NOT a signal — no lua-api DTO carries it', () => {
    expect(isActiveVersion('skill', { version: '1.0.0', deployedAt: '2026-01-01T00:00:00Z' })).toBe(false);
    expect(isActiveVersion('job', { version: '1.0.0', deployedAt: '2026-01-01T00:00:00Z' })).toBe(false);
  });

  test('tolerates garbage', () => {
    expect(isActiveVersion('skill', null)).toBe(false);
    expect(isActiveVersion('bogus', { active: true })).toBe(false);
  });
});

describe('versionCreatedAt / versionId / extractActiveVersionId', () => {
  test('normalises createdAt strings, skill createdDate strings and persona createdDate epoch-ms', () => {
    expect(versionCreatedAt({ createdAt: '2026-05-01T00:00:00Z' })).toBe('2026-05-01T00:00:00Z');
    expect(versionCreatedAt({ createdDate: '2026-05-01T00:00:00.000Z' })).toBe('2026-05-01T00:00:00.000Z');
    expect(versionCreatedAt({ createdDate: 1777593600000 })).toBe('2026-05-01T00:00:00.000Z');
    expect(versionCreatedAt({})).toBeNull();
    expect(versionCreatedAt(null)).toBeNull();
  });

  test('versionId prefers versionId, then id', () => {
    expect(versionId({ versionId: 'v1', id: 'x' })).toBe('v1');
    expect(versionId({ id: 'x' })).toBe('x');
    expect(versionId({})).toBeNull();
  });

  test('extractActiveVersionId reads data.activeVersionId when it is a non-empty string', () => {
    expect(extractActiveVersionId({ data: { activeVersionId: 'v9' } })).toBe('v9');
    expect(extractActiveVersionId({ data: { activeVersionId: '' } })).toBeNull();
    expect(extractActiveVersionId({ versions: [] })).toBeNull();
  });
});
