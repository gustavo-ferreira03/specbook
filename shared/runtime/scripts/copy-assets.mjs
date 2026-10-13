import { cp, copyFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

await cp(new URL("../src/assets", import.meta.url), new URL("../dist/assets", import.meta.url), { recursive: true });

const require = createRequire(import.meta.url);
const recorder = path.dirname(require.resolve("rrweb"));
const player = path.dirname(require.resolve("rrweb-player"));
await Promise.all([
    copyFile(path.join(recorder, "rrweb.umd.min.cjs"), new URL("../dist/assets/rrweb-recorder.js", import.meta.url)),
    copyFile(path.join(player, "rrweb-player.umd.min.cjs"), new URL("../dist/assets/rrweb-player.js", import.meta.url)),
    copyFile(path.join(player, "style.min.css"), new URL("../dist/assets/rrweb-player.css", import.meta.url)),
]);
