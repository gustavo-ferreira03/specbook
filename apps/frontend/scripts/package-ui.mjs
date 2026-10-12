import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const frontend = fileURLToPath(new URL("..", import.meta.url));
const root = path.resolve(frontend, "../..");
const manifest = JSON.parse(await fs.readFile(path.join(root, "apps/cli/package.json"), "utf8"));
const output = path.resolve(process.argv[2] ?? path.join(root, "dist/release"));
const build = path.join(frontend, process.env.NEXT_DIST_DIR ?? ".next");
const standalone = path.join(build, "standalone");
await fs.access(path.join(standalone, "apps/frontend/server.js")).catch(() => {
    throw new Error("Standalone UI is not built. Run pnpm --filter frontend build first.");
});

await fs.mkdir(output, { recursive: true });
const staging = await fs.mkdtemp(path.join(os.tmpdir(), "specbook-ui-"));
const filename = `specbook-ui-${manifest.version}.tar.gz`;
const artifact = path.join(output, filename);
try {
    await fs.cp(standalone, staging, { recursive: true, dereference: true });
    const packages = new Map();
    const store = path.join(standalone, "node_modules/.pnpm");
    for (const entry of await fs.readdir(store)) {
        const dependencies = path.join(store, entry, "node_modules");
        for (const name of await fs.readdir(dependencies).catch(() => [])) {
            const names = name.startsWith("@") ? (await fs.readdir(path.join(dependencies, name))).map((child) => `${name}/${child}`) : [name];
            for (const packageName of names) {
                if (packageName.startsWith(".")) continue;
                const source = path.join(dependencies, packageName);
                const dependency = JSON.parse(await fs.readFile(path.join(source, "package.json"), "utf8"));
                const previous = packages.get(packageName);
                if (previous && previous !== dependency.version) throw new Error(`Conflicting standalone versions of ${packageName}: ${previous} and ${dependency.version}`);
                if (!previous) {
                    packages.set(packageName, dependency.version);
                    await fs.cp(source, path.join(staging, "node_modules", packageName), { recursive: true, dereference: true });
                }
            }
        }
    }
    // Dereferenced pnpm packages need their dependencies in normal Node lookup paths.
    await fs.rm(path.join(staging, "node_modules/.pnpm"), { recursive: true });
    await fs.cp(path.join(frontend, "public"), path.join(staging, "apps/frontend/public"), { recursive: true });
    await fs.cp(path.join(build, "static"), path.join(staging, "apps/frontend/.next/static"), { recursive: true });
    await fs.rm(path.join(staging, "apps/frontend/.next/cache"), { recursive: true, force: true });
    // Keep Next's traced monorepo paths while giving serve a fixed entrypoint.
    await fs.writeFile(path.join(staging, "server.js"), "require('./apps/frontend/server.js');\n");
    await fs.writeFile(path.join(staging, "package.json"), `${JSON.stringify({ name: "specbook-ui", version: manifest.version, private: true, type: "commonjs" }, null, 2)}\n`);
    await new Promise((resolve, reject) => {
        const child = spawn("tar", ["-czf", artifact, "-C", staging, "."], { stdio: "inherit" });
        child.on("error", reject);
        child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`UI archive failed with exit code ${code}`)));
    });
    const checksum = createHash("sha256");
    for await (const chunk of createReadStream(artifact)) checksum.update(chunk);
    await fs.writeFile(`${artifact}.sha256`, `${checksum.digest("hex")}  ${filename}\n`);
    process.stdout.write(`Packaged ${artifact}\n`);
} finally {
    await fs.rm(staging, { recursive: true, force: true });
}
