import { parseArgs } from "node:util";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { z } from "zod";
import { initWorkspace, workspaceDirectory, newSpec, detectAgents, loadConfig } from "./workspace";
import { addProfile, listProfiles, removeProfile, scrub } from "./credentials";
import { checkSpecs } from "./check";
import { runLocal } from "./run";
import { generateReport } from "./report";

const help = `specbook — local behavior contracts and browser evidence

  init --base-url <url> [--agent claude|codex]
  spec new "<title>" --feature <name>
  spec check [path]
  run [spec|feature]
  report [run-id]
  credentials add <profile> [--stdin-json] [--origin <url>]
  credentials list
  credentials remove <profile>

Every command accepts --json. Credentials JSON comes from stdin, never arguments.
SPECBOOK_HOME overrides the user configuration directory.
`;

async function prompt(question: string): Promise<string> {
    if (!stdin.isTTY) throw new Error(`${question.trim()} Use the command option in non-interactive mode.`);
    const rl = readline.createInterface({ input: stdin, output: stdout });
    try { return (await rl.question(question)).trim(); } finally { rl.close(); }
}

async function secretPrompt(label: string): Promise<string> {
    if (!stdin.isTTY || !stdin.setRawMode) throw new Error("Use --stdin-json to provide credentials non-interactively");
    process.stderr.write(`${label}: `);
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    try {
        return await new Promise<string>((resolve, reject) => {
            let value = "";
            const onData = (buffer: Buffer) => {
                for (const char of buffer.toString()) {
                    if (char === "\u0003") { cleanup(); reject(new Error("Cancelled")); return; }
                    if (char === "\r" || char === "\n") { cleanup(); resolve(value); return; }
                    if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
                    else if (char >= " ") value += char;
                }
            };
            const cleanup = () => stdin.off("data", onData);
            stdin.on("data", onData);
        });
    } finally {
        stdin.setRawMode(wasRaw);
        stdin.pause();
        process.stderr.write("\n");
    }
}

async function credentialInput(): Promise<{ fields: Record<string, string>; origins?: string[] }> {
    let body = "";
    for await (const chunk of stdin) {
        body += chunk.toString();
        if (body.length > 100_000) throw new Error("Credential input is too large");
    }
    let data: unknown;
    try { data = JSON.parse(body); } catch { throw new Error("Provide valid JSON on stdin"); }
    const wrapped = z.object({ fields: z.record(z.string(), z.string()), origins: z.array(z.string()).optional() }).strict().safeParse(data);
    if (wrapped.success) return wrapped.data;
    const flat = z.record(z.string(), z.string()).safeParse(data);
    if (!flat.success) throw new Error("Credential JSON must contain string fields, or {fields:{...},origins:[...]}");
    return { fields: flat.data };
}

async function main(): Promise<void> {
    const raw = process.argv.slice(2);
    const { values, positionals } = parseArgs({ args: raw, allowPositionals: true, options: {
        json: { type: "boolean" }, help: { type: "boolean", short: "h" }, version: { type: "boolean" },
        "base-url": { type: "string" }, agent: { type: "string" }, feature: { type: "string" },
        secret: { type: "string" }, headed: { type: "boolean" }, timeout: { type: "string" },
        "stdin-json": { type: "boolean" }, origin: { type: "string", multiple: true },
    } });
    const [command, action, argument] = positionals;
    if (values.help || (!command && !values.version)) { stdout.write(values.json ? JSON.stringify({ help }) + "\n" : help); return; }
    if (values.version) { stdout.write(values.json ? '{"version":"0.1.0"}\n' : "0.1.0\n"); return; }
    const selectedAgent = values.agent ? z.enum(["claude", "codex"]).parse(values.agent) : undefined;
    const abort = new AbortController();
    process.once("SIGINT", () => abort.abort(new Error("Cancelled")));
    process.once("SIGTERM", () => abort.abort(new Error("Cancelled")));
    let result: unknown;
    if (command === "init") {
        const agents = detectAgents();
        result = await initWorkspace(process.cwd(), values["base-url"] ?? await prompt("Base URL: "), selectedAgent ?? agents[0]);
    } else if (command === "credentials") {
        if (action === "list") result = { profiles: await listProfiles() };
        else if (action === "remove") {
            if (!argument) throw new Error("Provide the profile name");
            result = await removeProfile(argument);
        } else if (action === "add") {
            const name = argument ?? await prompt("Profile name: ");
            let input: { fields: Record<string, string>; origins?: string[] };
            if (values["stdin-json"]) input = await credentialInput();
            else {
                const fields: Record<string, string> = {};
                const names = (await prompt("Field names (comma-separated, e.g. username,password): ")).split(",").map((field) => field.trim()).filter(Boolean);
                for (const name of names) fields[name] = await secretPrompt(name);
                input = { fields };
            }
            result = await addProfile(name, input.fields, values.origin ?? input.origins);
        } else throw new Error("Use credentials add, list or remove");
    } else {
        const workspace = await workspaceDirectory();
        if (command === "spec" && action === "new") {
            if (!argument || !values.feature) throw new Error('Use spec new "<title>" --feature <name>');
            result = await newSpec(workspace, argument, values.feature);
        } else if (command === "spec" && action === "check") {
            const check = await checkSpecs(workspace, argument);
            if (!check.ok) process.exitCode = 1;
            result = check;
        } else if (command === "run") {
            const run = await runLocal(workspace, action, { signal: abort.signal });
            if (run.status !== "passed") process.exitCode = 1;
            result = run;
        } else if (command === "report") result = await generateReport(workspace, action);
        else throw new Error(`Unknown command: ${command}${action ? ` ${action}` : ""}. Use --help.`);
    }
    const safe = await scrub(JSON.stringify(result, null, values.json ? undefined : 2));
    stdout.write(safe + "\n");
}

main().catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    let safe: string;
    try { safe = await scrub(message); } catch { safe = "Could not read credentials securely; check SPECBOOK_HOME and file permissions"; }
    if (process.argv.includes("--json")) stdout.write(JSON.stringify({ ok: false, error: safe }) + "\n");
    else process.stderr.write(`specbook: ${safe}\n`);
    process.exitCode = 1;
});
