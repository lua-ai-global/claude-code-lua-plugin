#!/usr/bin/env node
import { build } from 'esbuild';

// EM-WS8 (1.6.0): EVERYTHING is bundled, `@modelcontextprotocol/sdk` included.
// The plugin ships no node_modules — marketplace installs copy the directory
// verbatim and the Lua Job tier bakes it into an image the same way — so an
// external SDK made the server die with ERR_MODULE_NOT_FOUND on every install
// (Claude Code shows it as `lua-platform CONNECTION_CLOSED`).
// tests/standalone-bundle.test.mjs copies dist/server.js into an empty temp
// directory and lists the tools over stdio to keep it that way.
//
// Iteration-13 audit: `packages: 'bundle'` is not used — that option only
// exists in esbuild >=0.22 and the pinned dep is `^0.20.0`; `bundle: true`
// with no `external` already bundles every npm import. Node builtins stay
// external automatically (`platform: 'node'`).
//
// The banner gives the ESM bundle a real `require`, so any CommonJS module
// the SDK pulls in can still `require()` a node builtin.
await build({
  entryPoints: ['src/server.mjs'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  banner: {
    js: "import { createRequire as __luaCreateRequire } from 'node:module'; const require = __luaCreateRequire(import.meta.url);",
  },
  minify: true,
  sourcemap: 'inline',
  outfile: 'dist/server.js',
});

console.log('✓ Bundled to dist/server.js (self-contained, no runtime node_modules needed)');
