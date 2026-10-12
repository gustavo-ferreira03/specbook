import { build } from 'esbuild';
import fs from 'node:fs/promises';

const { version } = JSON.parse(await fs.readFile(new URL('../../cli/package.json', import.meta.url), 'utf8'));
await build({
    entryPoints: ['src/index.ts', 'src/operations-cli.ts'], bundle: true, platform: 'node', format: 'esm',
    packages: 'external', outdir: 'dist', define: { SPECBOOK_CLI_VERSION: JSON.stringify(version) },
});
await fs.mkdir('dist/prompts', { recursive: true });
await fs.cp('src/core/chat/prompts', 'dist/prompts', { recursive: true });
