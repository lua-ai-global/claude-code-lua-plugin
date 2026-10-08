import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFixtureRun } from './fixture-run.mjs';
import { loadRunData, buildResults } from '../../../../lib/qa/report/results.mjs';

export function makeIo(cwd = process.cwd()) {
  const out = [];
  const err = [];
  return { out: { write: (s) => out.push(s) }, err: { write: (s) => err.push(s) }, cwd, env: {}, _out: out, _err: err, json: () => JSON.parse(out.join('').trim().split('\n').pop()) };
}

export async function tmpRun() {
  const base = await mkdtemp(join(tmpdir(), 'qa-report-'));
  const dir = join(base, 'run');
  await writeFixtureRun(dir);
  return { base, dir, cleanup: () => rm(base, { recursive: true, force: true }) };
}

export async function fixtureResults() {
  const { dir, cleanup } = await tmpRun();
  const data = await loadRunData(dir);
  const results = buildResults(data, { now: () => new Date('2026-10-07T16:00:00.000Z') });
  await cleanup();
  return { results, cards: data.cards };
}
