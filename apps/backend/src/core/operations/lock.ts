import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { storageRoot } from "../paths";

export async function acquireStorageLock(root = storageRoot): Promise<() => Promise<void>> {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const child = spawn("flock", ["--exclusive", "--nonblock", path.join(root, ".operations.lock"), process.execPath,
        "-e", "process.stdout.write('locked\\n');process.stdin.resume();"], { stdio: ["pipe", "pipe", "pipe"] });
    const exited = new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.once("error", () => resolve()); });
    await new Promise<void>((resolve, reject) => {
        child.once("error", () => reject(new Error("Specbook needs the flock command from util-linux to protect its storage.")));
        child.once("exit", () => reject(new Error("This storage is in use. Stop Specbook before running backup, restore or key rotation.")));
        child.stdout.once("data", () => resolve());
    });
    child.stdout.resume();
    child.stderr.resume();
    return async () => { child.stdin.end(); await exited; };
}
