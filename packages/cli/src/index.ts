import { parseArgs } from "node:util";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { z } from "zod";
import { initWorkspace, workspaceDirectory, newSpec, detectAgents, loadConfig } from "./workspace";
import { addProfile, listProfiles, removeProfile, scrub } from "./credentials";
import { checkSpecs } from "./check";
import { runLocal } from "./run";
import { generateReport } from "./report";
import { browse, startBrowserDaemon } from "./browser";
import { sendMessage, listConversations, runChatWorker, printReply } from "./chat";
import { chatReplySchema, chatReplyJsonSchema, type ChatReply } from "./chat-model";
import { runMcpServer } from "./mcp";

const help = `specbook — local behavior contracts and browser evidence

  init --base-url <url> [--agent claude|codex]
  spec new "<title>" --feature <name>
  spec check [path]
  run [spec|feature]
  report [run-id]
  credentials add <profile> [--stdin-json] [--origin <url>]
  credentials list
  credentials remove <profile>
  browse open [url] [--headed]
  browse snapshot | inspect <ref> | click <ref>
  browse fill <ref> <text> | fill <ref> --secret profile.field
  browse close
  chat "<message>" [--agent claude|codex] [--timeout <seconds>] [--no-wait]
  chat <id> "<reply>"
  chat <id> --select 1,2
  chat <id> --wait
  chats

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
    if (raw[0] === "--browse-daemon") {
        await startBrowserDaemon(raw[1], raw[2], raw.includes("--headed"));
        return;
    }
    if (raw[0] === "--mcp") {
        await runMcpServer(raw[1], raw[2]);
        return;
    }
    if (raw[0] === "--chat-worker") {
        await runChatWorker(raw[1], raw[2], raw[3]);
        return;
    }
    const { values, positionals } = parseArgs({ args: raw, allowPositionals: true, options: {
        json: { type: "boolean" }, help: { type: "boolean", short: "h" }, version: { type: "boolean" },
        "base-url": { type: "string" }, agent: { type: "string" }, feature: { type: "string" },
        secret: { type: "string" }, headed: { type: "boolean" }, timeout: { type: "string" },
        "stdin-json": { type: "boolean" }, origin: { type: "string", multiple: true },
        select: { type: "string" }, wait: { type: "boolean" }, "no-wait": { type: "boolean" },
    } });
    const [command, action, argument] = positionals;
    if (values.help || (!command && !values.version)) { stdout.write(values.json ? JSON.stringify({ help, chatReplySchema: chatReplyJsonSchema }) + "\n" : help); return; }
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
        else if (command === "browse") {
            const config = await loadConfig(workspace);
            result = await browse(action, { workspace, baseUrl: config.baseUrl, url: action === "open" ? argument : undefined, ref: action === "open" ? undefined : argument, value: positionals[3], secret: values.secret, headed: values.headed });
        } else if (command === "chat") {
            const timeout = values.timeout === undefined ? 600 : Number(values.timeout);
            result = chatReplySchema.parse(await sendMessage(workspace, positionals.slice(1), { agent: selectedAgent, timeoutMs: timeout * 1000, signal: abort.signal, wait: values.wait, noWait: values["no-wait"], select: values.select }));
            if ((result as ChatReply).status === "failed" || (result as ChatReply).specs?.some((spec) => spec.status !== "passed")) process.exitCode = 1;
        } else if (command === "chats") {
            if (positionals.length !== 1) throw new Error("Use specbook chats without arguments");
            result = await listConversations(workspace);
        } else throw new Error(`Unknown command: ${command}${action ? ` ${action}` : ""}. Use --help.`);
    }
    if (command === "chat") { stdout.write((values.json ? JSON.stringify(result) : printReply(result as ChatReply)) + "\n"); return; }
    if (command === "chats") { stdout.write(JSON.stringify(result, null, values.json ? undefined : 2) + "\n"); return; }
    const safe = await scrub(JSON.stringify(result, null, values.json ? undefined : 2));
    stdout.write(safe + "\n");
}

main().catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    let safe: string;
    try { safe = await scrub(message); } catch { safe = "Could not read credentials securely; check SPECBOOK_HOME and file permissions"; }
    if (process.argv.includes("--json")) {
        const raw = process.argv.slice(2);
        const chat = raw.includes("chat");
        const id = raw.find((item) => /^c-[a-f0-9]{8}$/.test(item)) ?? "";
        stdout.write(JSON.stringify(chat ? chatReplySchema.parse({ id, status: "failed", message: safe, error: safe }) : { ok: false, error: safe }) + "\n");
    }
    else process.stderr.write(`specbook: ${safe}\n`);
    process.exitCode = 1;
});
