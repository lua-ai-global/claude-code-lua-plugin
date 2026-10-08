// The plugin version the fixtures stamp into run.json and the installed-cache paths the permission tests use,
// read from package.json so a release bump never leaves the tests on a stale version.

import { readFileSync } from 'node:fs';

export const PLUGIN_VERSION = JSON.parse(readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')).version;

/** An installed-plugin cache path to this version's helper, as Claude Code lays it out. */
export const cacheCliPath = (home = '/h/.claude', marketplace = 'm') => `${home}/plugins/cache/${marketplace}/lua-agent-builder/${PLUGIN_VERSION}/lib/qa/cli.mjs`;
