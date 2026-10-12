import { spawn } from "node:child_process";
import { z } from "zod";
import { CodedError } from "@specbook/runtime/errors";
import { SECRET_NAME_PATTERN } from "@specbook/runtime/specbook/guard";

const fieldsSchema = z.record(z.string().regex(SECRET_NAME_PATTERN), z.string().min(1).max(65_536));

export async function providerFields(command: string, profile: string, signal?: AbortSignal): Promise<Record<string, string>> {
    if (!command.trim() || command.length > 16_384) throw new CodedError("credentials", "Provide a nonempty secret provider command");
    z.string().regex(SECRET_NAME_PATTERN).parse(profile);
    signal?.throwIfAborted();
    let data = "";
    let tooLarge = false;
    let timedOut = false;
    const child = process.platform === "win32"
        ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `${command} ${profile}`], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true })
        : spawn("/bin/sh", ["-c", `${command} "$1"`, "specbook-secrets", profile], { stdio: ["ignore", "pipe", "ignore"], detached: true });
    const kill = () => {
        if (process.platform !== "win32" && child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* The command may have already exited. */ } }
        else child.kill("SIGKILL");
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, 30_000);
    const abort = () => kill();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
        if (tooLarge) return;
        data += chunk;
        if (Buffer.byteLength(data) > 1_048_576) { tooLarge = true; data = ""; kill(); }
    });
    try {
        const code = await new Promise<number | null>((resolve, reject) => {
            child.once("error", () => reject(new CodedError("credentials", `Could not start the secret provider for profile "${profile}"`)));
            child.once("close", resolve);
        });
        signal?.throwIfAborted();
        if (timedOut || tooLarge || code !== 0) throw new CodedError("credentials", `Secret provider for profile "${profile}" ${timedOut ? "timed out" : tooLarge ? "returned too much data" : "failed"}; check the provider configuration`);
        let parsed: unknown;
        try { parsed = JSON.parse(data); } catch { throw new CodedError("credentials", `Secret provider for profile "${profile}" must print one JSON object of string fields`); }
        const result = fieldsSchema.safeParse(parsed);
        if (!result.success) throw new CodedError("credentials", `Secret provider for profile "${profile}" must print valid named, nonempty string fields`);
        return result.data;
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}
