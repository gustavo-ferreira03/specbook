import { build } from 'esbuild';
import fs from 'node:fs/promises';
const manifest = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
await fs.mkdir('dist', { recursive: true });
await build({
  entryPoints: ['src/index.ts'], bundle: true, platform: 'node', format: 'esm',
  target: 'node22', outfile: 'dist/index.js',
  external: Object.keys(manifest.dependencies),
  banner: { js: '#!/usr/bin/env node' },
});
// The workspace dependency link points at the runtime package wherever it lives in the monorepo.
const runtime = await fs.realpath('node_modules/@specbook/runtime');
await fs.copyFile(`${runtime}/dist/specbook-fixtures.mjs`, 'dist/specbook-fixtures.mjs');
await fs.cp(`${runtime}/dist/assets`, 'dist/assets', { recursive: true });
await fs.chmod('dist/index.js', 0o755);
await fs.copyFile('../../docs/cli/README.md', 'dist/README.md');
await fs.cp('../../docs/cli/examples', 'dist/examples', { recursive: true });
await build({
  entryPoints: ['../backend/src/index.ts'], bundle: true, platform: 'node', format: 'esm',
  target: 'node22', outfile: 'dist/server/index.js',
  external: Object.keys(manifest.dependencies),
});
await fs.copyFile(`${runtime}/dist/specbook-fixtures.mjs`, 'dist/server/specbook-fixtures.mjs');
await fs.cp(`${runtime}/dist/assets`, 'dist/server/assets', { recursive: true });
await fs.cp('../backend/src/core/chat/prompts', 'dist/server/prompts', { recursive: true });
await fs.cp('../backend/drizzle', 'dist/server/drizzle', { recursive: true });
