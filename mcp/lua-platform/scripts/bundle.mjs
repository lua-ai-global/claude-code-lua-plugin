#!/usr/bin/env node
import { build } from 'esbuild';

// Iteration-13 audit: removed `packages: 'bundle'` — that option only exists
// in esbuild ≥0.22 but the pinned dep is `^0.20.0` (would fail at build with
// `Invalid value "bundle" in "--packages=bundle"`). The MCP server has only
// one npm runtime dep (`@modelcontextprotocol/sdk`, marked external below)
// and node builtins (auto-external), so `bundle: true` alone correctly
// bundles every relative import without needing `packages: 'bundle'`.
await build({
  entryPoints: ['src/server.mjs'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  external: ['@modelcontextprotocol/sdk'],
  minify: true,
  sourcemap: 'inline',
  outfile: 'dist/server.js',
});

console.log('✓ Bundled to dist/server.js');
