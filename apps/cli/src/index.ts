import { stdin, stdout, stderr } from "node:process";
import { Command, CommanderError, Option } from "commander";
import * as clack from "@clack/prompts";
import pc from "picocolors";
import { z } from "zod";
import { initWorkspace, workspaceDirectory, newSpec, detectAgents, loadConfig } from "./workspace";
import { addProfile, listProfiles, removeProfile, scrub } from "./credentials";
import { checkSpecs } from "./check";
import { runLocal } from "./run";
import { generateReport } from "./report";
import { browse, startBrowserDaemon } from "./browser";
import { sendMessage, listConversations, runChatWorker } from "./chat";
import { chatReplySchema, chatReplyJsonSchema, type ChatReply } from "./chat-model";
import { runMcpServer } from "./mcp";
import { login, logout, connectionChoices, environmentChoices, connect, pull, publish, rememberToken, scrubTokens, redactTokens, RemoteError } from "./remote";
import { runCi, type CiOptions } from "./ci";
import { scrubCi } from "./ci-comment";
import * as ui from "./ui";
import { CLI_VERSION } from "./version";

const json = process.argv.includes("--json");
const isChatCommand = process.argv.slice(2).find((argument) => !argument.startsWith("-")) === "chat";
stdout.on("error", (error: NodeJS.ErrnoException) => { if (error.code === "EPIPE") process.exit(0); throw error; });
const interactive = !json && !!stdin.isTTY && !!stderr.isTTY;
const agentOption = () => new Option("--agent <agent>", "local coding agent that drives Specbook").choices(["claude", "codex"]);

// Human output and JSON share one call site so secrets are scrubbed on every path.
async function print(result: unknown, render: () => string): Promise<void> {
    stdout.write(scrubCi(await scrubTokens(await scrub(json ? JSON.stringify(result) : render()))) + "\n");
}

async function working<T>(label: string, task: (spinner?: ReturnType<typeof clack.spinner>) => Promise<T>, indicator: "dots" | "timer" = "dots"): Promise<T> {
    if (!interactive) return task();
    const spinner = clack.spinner({ output: stderr, withGuide: false, indicator, onCancel: () => {} });
    spinner.start(label);
    try {
        const result = await task(spinner);
        spinner.clear();
        return result;
    } catch (error) {
        spinner.clear();
        throw error;
    }
}

function answer<T>(value: T | symbol): Exclude<T, symbol> {
    if (clack.isCancel(value)) {
        clack.cancel("Cancelled");
        process.exit(130);
    }
    return value as Exclude<T, symbol>;
}

function needsInteractive(what: string): never {
    throw new Error(`${what} Pass it as an option when running non-interactively.`);
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

async function promptCredentials(name: string | undefined) {
    if (!interactive) throw new Error("Use --stdin-json to provide credentials non-interactively");
    clack.intro(pc.inverse(" specbook credentials "), { output: stderr });
    const profile = name ?? answer(await clack.text({
        message: "Profile name", placeholder: "admin", output: stderr,
        validate: (value) => /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(value ?? "") ? undefined : "Start with a letter; use letters, digits, - or _",
    }));
    const names = answer(await clack.text({
        message: "Field names", placeholder: "username, password", output: stderr,
        validate: (value) => (value ?? "").split(",").some((field) => field.trim()) ? undefined : "Enter at least one field",
    })).split(",").map((field) => field.trim()).filter(Boolean);
    const fields: Record<string, string> = {};
    for (const field of names) fields[field] = answer(await clack.password({ message: field, output: stderr }));
    clack.outro(pc.dim("Values are stored only on this machine."), { output: stderr });
    return { profile, fields };
}

function exitWith(reply: ChatReply) {
    if (reply.status === "failed" || reply.specs?.some((spec) => spec.status !== "passed")) process.exitCode = 1;
}

const program = new Command("specbook")
    .description("Behavior contracts for web apps, written and verified by your coding agent.")
    .version(CLI_VERSION, "-v, --version", "print the version")
    .helpCommand(false)
    .usage("<command> [options]")
    .option("--json", "print machine-readable JSON (for coding agents)")
    .helpOption("-h, --help", "show help")
    .showHelpAfterError(pc.dim("(add --help for usage)"))
    .configureHelp({
        sortSubcommands: false,
        helpWidth: Math.min(stdout.columns || 100, 100),
        subcommandTerm: (command) => [
            command.name(),
            command.commands.length > 3 ? "<action>" : command.commands.length ? command.commands.map((child) => child.name()).join("|") : "",
            ...command.registeredArguments.map((argument) => argument.required ? `<${argument.name()}>` : `[${argument.name()}${argument.variadic ? "..." : ""}]`),
        ].filter(Boolean).join(" "),
        styleTitle: (text) => pc.bold(text),
        styleCommandText: (text) => pc.bold(text),
        styleSubcommandTerm: (text) => pc.cyan(text),
        styleOptionTerm: (text) => pc.yellow(text),
        styleArgumentTerm: (text) => pc.yellow(text),
        styleDescriptionText: (text) => pc.dim(text),
    })
    .configureOutput({
        writeErr: (text) => { if (!json) stderr.write(scrubCi(redactTokens(text))); },
        outputError: (text, write) => write(ui.failure(text.replace(/^error: /, "")) + "\n"),
    })
    .exitOverride()
    .addHelpText("before", `${pc.bold("specbook")} ${pc.dim(CLI_VERSION)}\n`)
    .addHelpText("after", `
${pc.bold("Start here")}
  ${pc.dim("$")} ${pc.cyan('specbook init --base-url http://localhost:3000')}
  ${pc.dim("$")} ${pc.cyan('specbook chat "a signed-in user can add an item to the cart"')}

${pc.dim("Every command accepts --json. SPECBOOK_HOME overrides the user configuration directory.")}`);

program.command("chat")
    .helpGroup("Write Specs with your agent:")
    .description("talk to Specbook: it explores, asks, proposes and writes Specs")
    .argument("[id-or-message...]", '"<message>" to start, or <id> "<reply>" to continue')
    .addOption(agentOption())
    .option("--select <numbers>", "pick proposed Specs, e.g. 1,2")
    .option("--wait", "wait for a running turn and print its reply")
    .option("--no-wait", "return immediately while the turn keeps running")
    .option("--timeout <seconds>", "how long to wait for the turn", "600")
    .addHelpText("after", `
${pc.bold("Examples")}
  ${pc.dim("$")} ${pc.cyan('specbook chat "guests can check out with a saved card"')}
  ${pc.dim("$")} ${pc.cyan('specbook chat c-1a2b3c4d "only the EU store"')}
  ${pc.dim("$")} ${pc.cyan("specbook chat c-1a2b3c4d --select 1,3")}`)
    .action(async (args: string[], options: { agent?: "claude" | "codex"; select?: string; wait?: boolean; timeout: string }) => {
        const workspace = await workspaceDirectory();
        const abort = new AbortController();
        process.once("SIGINT", () => abort.abort(new Error("Cancelled")));
        process.once("SIGTERM", () => abort.abort(new Error("Cancelled")));
        const timeout = Number(options.timeout);
        if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("Use a positive --timeout in seconds");
        const send = () => sendMessage(workspace, args, {
            agent: options.agent, timeoutMs: timeout * 1000, signal: abort.signal,
            wait: options.wait === true, noWait: options.wait === false, select: options.select,
        });
        const label = options.select ? "Writing and running the selected Specs" : options.wait === false ? "Starting the turn" : "Specbook is working";
        const reply = chatReplySchema.parse(await working(label, send, options.wait === false ? "dots" : "timer"));
        exitWith(reply);
        await print(reply, () => ui.renderReply(reply));
    });

program.command("chats")
    .helpGroup("Write Specs with your agent:")
    .description("list conversations")
    .action(async () => {
        const result = await listConversations(await workspaceDirectory());
        await print(result, () => ui.renderConversations(result));
    });

program.command("init")
    .helpGroup("Setup:")
    .description("create the .specbook workspace and install the agent skill")
    .option("--base-url <url>", "URL of the app under test")
    .addOption(agentOption())
    .action(async (options: { baseUrl?: string; agent?: "claude" | "codex" }) => {
        const agents = detectAgents();
        let baseUrl = options.baseUrl;
        let agent = options.agent ?? agents[0];
        if (!baseUrl) {
            if (!interactive) needsInteractive("The base URL is required.");
            clack.intro(pc.inverse(" specbook init "), { output: stderr });
            baseUrl = answer(await clack.text({
                message: "Where does the app run?", placeholder: "http://localhost:3000", output: stderr,
                validate: (value) => { try { return /^https?:$/.test(new URL(value ?? "").protocol) ? undefined : "Use an http(s) URL"; } catch { return "Use a full URL, like http://localhost:3000"; } },
            }));
            if (!options.agent && agents.length > 1) {
                agent = answer(await clack.select({ message: "Which coding agent should drive Specbook?", output: stderr, options: agents.map((value) => ({ value, label: value })) }));
            }
            clack.outro(pc.dim("Writing the workspace"), { output: stderr });
        }
        const result = await initWorkspace(process.cwd(), baseUrl, agent) as Parameters<typeof ui.renderInit>[0];
        await print(result, () => ui.renderInit(result));
    });

program.command("login")
    .helpGroup("Connect to a team:")
    .description("verify and save a personal access token on this machine")
    .argument("<server-url>", "the hosted Specbook URL or backend API URL")
    .option("--stdin", "read the token from stdin")
    .action(async (url: string, options: { stdin?: boolean }) => {
        let token = "";
        if (options.stdin) {
            for await (const chunk of stdin) {
                token += chunk.toString();
                if (token.length > 4096) throw new Error("Token input is too large");
            }
            token = token.trim();
        } else {
            if (!interactive) throw new Error("Use --stdin to provide a personal access token non-interactively");
            token = answer(await clack.password({ message: "Personal access token", output: stderr }));
        }
        rememberToken(token);
        const result = await working("Verifying access token", () => login(url, token));
        await print(result, () => ui.renderLogin(result));
    });

program.command("logout")
    .helpGroup("Connect to a team:")
    .description("remove a saved server login; defaults to the most recent")
    .argument("[url]", "server URL to remove")
    .action(async (url?: string) => {
        const result = await logout(url);
        await print(result, () => ui.renderLogout(result));
    });

program.command("connect")
    .helpGroup("Connect to a team:")
    .description("link this workspace to a remote project and environment")
    .argument("[project]", "project id or name; select interactively when omitted")
    .option("--server <url>", "saved server URL; defaults to the most recent login")
    .option("--environment <name>", "environment name or id; defaults to Production")
    .action(async (selected: string | undefined, options: { server?: string; environment?: string }) => {
        const workspace = await workspaceDirectory();
        const { server, projects } = await working("Loading projects", () => connectionChoices(options.server));
        if (!projects.length) throw new Error("No projects are available to this user");
        if (!selected) {
            if (!interactive) throw new Error("Provide a project id or name when running non-interactively");
            selected = answer(await clack.select({ message: "Connect to which project?", output: stderr, options: projects.map((project) => ({ value: project.id, label: project.name, hint: project.baseUrl })) }));
        }
        const matches = projects.filter((project) => project.id === selected || project.name.toLowerCase() === selected!.toLowerCase());
        if (matches.length !== 1) throw new Error(matches.length ? "Project name is ambiguous; use its id" : "Project not found or access denied");
        const project = matches[0]!;
        const environments = await environmentChoices(server, project.id);
        const name = options.environment ?? "Production";
        const environment = environments.find((entry) => entry.id === name || entry.name.toLowerCase() === name.toLowerCase());
        if (!environment) throw new Error("Environment not found; use --environment with an existing name or id");
        const result = await connect(workspace, server, project, environment);
        await print(result, () => ui.renderConnect(result));
    });

program.command("pull")
    .helpGroup("Connect to a team:")
    .description("download remote Specs, preserving local unpublished edits")
    .action(async () => {
        const result = await working("Pulling remote Specs", async () => pull(await workspaceDirectory()));
        if (result.conflicts.length) process.exitCode = 1;
        await print(result, () => ui.renderPull(result));
    });

program.command("publish")
    .helpGroup("Connect to a team:")
    .description("publish locally passing Specs with a remote revision check")
    .argument("[selector]", "a Spec or feature path; all Specs when omitted")
    .option("--run", "run the selected Specs before publishing")
    .option("--environment <name>", "target environment; defaults to the connected environment")
    .action(async (selector: string | undefined, options: { run?: boolean; environment?: string }) => {
        const result = await working(options.run ? "Running and publishing Specs" : "Publishing Specs", async () => publish(await workspaceDirectory(), selector, options), options.run ? "timer" : "dots");
        await print(result, () => ui.renderPublish(result));
    });

program.command("ci")
    .helpGroup("Verify:")
    .description("run remote Specs with a project CI token and save reports")
    .option("--url <url>", "Specbook server URL; defaults to SPECBOOK_URL")
    .option("--token <token>", "project CI token; prefer SPECBOOK_TOKEN")
    .option("--project <id>", "project id; defaults to SPECBOOK_PROJECT")
    .option("--environment <name>", "target server environment")
    .option("--base-url <url>", "preview base URL for this run")
    .option("--feature-id <id>", "run one remote feature")
    .option("--spec-ids <ids>", "comma-separated remote Spec ids")
    .option("--timeout <seconds>", "maximum wait; defaults to 3600 seconds")
    .option("--report <path>", "HTML report path; defaults to specbook-report.html")
    .option("--junit <path>", "JUnit path; defaults to specbook-junit.xml")
    .option("--summary <path>", "Markdown summary path; defaults to specbook-summary.md")
    .option("--commit-sha <sha>", "commit associated with this run")
    .option("--ref <ref>", "branch or tag associated with this run")
    .option("--build-url <url>", "pipeline URL")
    .option("--fail-on-flaky", "include flaky Specs in the quality gate")
    .option("--fail-on-known-bugs", "include known bugs in the quality gate")
    .addOption(new Option("--comment <provider>", "publish a pipeline summary comment").choices(["github", "gitlab", "none"]))
    .action(async (options: CiOptions) => {
        const result = await working("Waiting for remote Specs", () => runCi(options), "timer");
        if (!result.qualityGate.passed) process.exitCode = 1;
        await print(result, () => ui.renderCi(result));
    });

program.command("runner")
    .helpGroup("Host Specbook:")
    .description("claim private-network runs over outbound HTTP and upload evidence")
    .option("--url <url>", "Specbook server URL; defaults to SPECBOOK_URL")
    .option("--server <url>", "Specbook server URL")
    .option("--concurrency <number>", "jobs executed at the same time; defaults to SPECBOOK_RUNNER_CONCURRENCY or 1")
    .option("--once", "finish one claimed run, then exit")
    .option("--drain-after <number>", "finish this many claimed runs, then exit")
    .option("--allow-origin <origin>", "application origin this runner may access; repeat for more origins", (origin: string, previous: string[]) => [...previous, origin], [])
    .option("--secrets-command <command>", "JSON secret provider; defaults to SPECBOOK_SECRETS_COMMAND")
    .addHelpText("after", `\n${pc.dim("Set SPECBOOK_RUNNER_TOKEN from your secret store. Secrets resolve from environment variables, a provider command, then local profiles.")}`)
    .action(async (options: { url?: string; server?: string; concurrency?: string; once?: boolean; drainAfter?: string; allowOrigin: string[]; secretsCommand?: string }) => {
        const url = options.url ?? options.server ?? process.env.SPECBOOK_URL;
        if (!url) throw new Error("SPECBOOK_URL or --url is required");
        let token = process.env.SPECBOOK_RUNNER_TOKEN;
        if (!token) {
            if (!interactive) throw new Error("Set SPECBOOK_RUNNER_TOKEN when running non-interactively");
            token = answer(await clack.password({ message: "Runner token", output: stderr }));
        }
        rememberToken(token);
        const abort = new AbortController();
        const cancel = () => abort.abort(new Error("Runner stopped"));
        process.once("SIGINT", cancel);
        process.once("SIGTERM", cancel);
        try {
            const { runRunner } = await import("./runner");
            const once = options.once ?? process.env.SPECBOOK_RUNNER_ONCE === "true";
            const drainAfter = options.drainAfter ?? process.env.SPECBOOK_RUNNER_DRAIN_AFTER;
            await runRunner({ url, token, concurrency: Number(options.concurrency ?? process.env.SPECBOOK_RUNNER_CONCURRENCY ?? 1),
                once, drainAfter: drainAfter === undefined ? undefined : Number(drainAfter),
                allowedOrigins: options.allowOrigin.length ? options.allowOrigin : process.env.SPECBOOK_RUNNER_ALLOWED_ORIGINS?.split(/[\s,]+/).filter(Boolean),
                secretsCommand: options.secretsCommand ?? process.env.SPECBOOK_SECRETS_COMMAND, signal: abort.signal },
                (event) => print(event, () => ui.renderRunnerEvent(event)));
        } finally {
            process.removeListener("SIGINT", cancel);
            process.removeListener("SIGTERM", cancel);
        }
    });

program.command("tunnel")
    .helpGroup("Host Specbook:")
    .description("connect server browsers to a private app over an outbound tunnel")
    .option("--url <url>", "Specbook server URL; defaults to SPECBOOK_URL")
    .option("--server <url>", "Specbook server URL")
    .option("--project <id>", "project id; defaults to SPECBOOK_PROJECT")
    .option("--environment <name>", "target environment; defaults to SPECBOOK_ENVIRONMENT or Production")
    .option("--allow-origin <origin>", "application origin this tunnel may access; repeat for more origins", (origin: string, previous: string[]) => [...previous, origin], [])
    .addHelpText("after", `\n${pc.dim("Set SPECBOOK_RUNNER_TOKEN from your secret store. Choose a tunnel token matching the environment's runner group and project, and configure --allow-origin.")}`)
    .action(async (options: { url?: string; server?: string; project?: string; environment?: string; allowOrigin: string[] }) => {
        const url = options.url ?? options.server ?? process.env.SPECBOOK_URL;
        if (!url) throw new Error("SPECBOOK_URL or --url is required");
        const project = options.project ?? process.env.SPECBOOK_PROJECT;
        if (!project || !z.string().uuid().safeParse(project).success) throw new Error("SPECBOOK_PROJECT or --project must be a project id");
        let token = process.env.SPECBOOK_RUNNER_TOKEN;
        if (!token) {
            if (!interactive) throw new Error("Set SPECBOOK_RUNNER_TOKEN when running non-interactively");
            token = answer(await clack.password({ message: "Tunnel token", output: stderr }));
        }
        rememberToken(token);
        const abort = new AbortController();
        const cancel = () => abort.abort(new Error("Tunnel stopped"));
        process.once("SIGINT", cancel);
        process.once("SIGTERM", cancel);
        try {
            const { runTunnel } = await import("./tunnel");
            await runTunnel({ url, token, project, environment: options.environment ?? process.env.SPECBOOK_ENVIRONMENT,
                allowedOrigins: options.allowOrigin.length ? options.allowOrigin : process.env.SPECBOOK_TUNNEL_ALLOWED_ORIGINS?.split(/[\s,]+/).filter(Boolean), signal: abort.signal },
                (event) => print(event, () => ui.renderTunnelEvent(event)));
        } finally {
            process.removeListener("SIGINT", cancel);
            process.removeListener("SIGTERM", cancel);
        }
    });

program.command("serve")
    .helpGroup("Host Specbook:")
    .description("start the API, worker, steward, schedules and web UI")
    .option("--port <number>", "web UI port; defaults to FRONTEND_PORT or 4001")
    .option("--host <address>", "listen address; defaults to HOST or 127.0.0.1")
    .option("--data <directory>", "storage directory; defaults to SPECBOOK_STORAGE_DIR or SPECBOOK_HOME/server")
    .option("--ui <directory>", "extracted standalone UI; otherwise use the bundled or cached UI")
    .action(async (options: { port?: string; host?: string; data?: string; ui?: string }) => {
        const abort = new AbortController();
        const cancel = () => abort.abort(new Error("Specbook stopped"));
        process.once("SIGINT", cancel);
        process.once("SIGTERM", cancel);
        try {
            const { runServe } = await import("./serve");
            await runServe({ ...options, signal: abort.signal }, (event) => print(event, () => {
                if (event.event === "downloading_ui") return `${pc.cyan("●")} Downloading the web UI for Specbook ${event.version}`;
                if (event.event === "stopped") return pc.dim("Specbook stopped");
                return `${ui.success("Specbook is ready")}\n${pc.cyan(event.url)}\n${pc.dim(`Storage: ${event.data}`)}`;
            }), (line) => stderr.write(line + "\n"));
        } finally {
            process.removeListener("SIGINT", cancel);
            process.removeListener("SIGTERM", cancel);
        }
    });

const spec = program.command("spec").description("scaffold and validate Specs").helpGroup("Write Specs by hand:");
spec.command("new")
    .description("scaffold spec.yml and spec.ts")
    .argument("<title>", "what the Spec verifies")
    .requiredOption("--feature <name>", "feature the Spec belongs to")
    .action(async (title: string, options: { feature: string }) => {
        const workspace = await workspaceDirectory();
        const result = await newSpec(workspace, title, options.feature) as Parameters<typeof ui.renderNewSpec>[0];
        await print(result, () => ui.renderNewSpec(result, workspace));
    });
spec.command("check")
    .description("validate Specs, and their locators against the open browser")
    .argument("[path]", "a Spec or feature path")
    .action(async (selector?: string) => {
        const workspace = await workspaceDirectory();
        const result = await working("Checking Specs", () => checkSpecs(workspace, selector));
        if (!result.ok) process.exitCode = 1;
        await print(result, () => ui.renderCheck(result));
    });

program.command("run")
    .helpGroup("Verify:")
    .description("run Specs in a fresh, signed-out browser and record evidence")
    .argument("[selector]", "a Spec or feature path; all Specs when omitted")
    .action(async (selector: string | undefined) => {
        const workspace = await workspaceDirectory();
        const abort = new AbortController();
        process.once("SIGINT", () => abort.abort(new Error("Cancelled")));
        process.once("SIGTERM", () => abort.abort(new Error("Cancelled")));
        const run = await working(`Running ${selector ?? "all Specs"}`, () => runLocal(workspace, selector, { signal: abort.signal }), "timer");
        if (run.status !== "passed") process.exitCode = 1;
        await print(run, () => ui.renderRun(run));
    });

program.command("report")
    .helpGroup("Verify:")
    .description("write the self-contained HTML report for a run")
    .argument("[run-id]", "defaults to the latest run")
    .action(async (id?: string) => {
        const result = await generateReport(await workspaceDirectory(), id);
        await print(result, () => ui.renderReport(result));
    });

const credentials = program.command("credentials").description("manage local login profiles used by secret()").helpGroup("Setup:");
credentials.command("add")
    .description("add or replace a profile (values via hidden prompt or stdin)")
    .argument("[profile]", "profile name, e.g. admin")
    .option("--stdin-json", "read {\"field\":\"value\"} JSON from stdin")
    .option("--origin <url...>", "origins allowed to receive these values")
    .action(async (name: string | undefined, options: { stdinJson?: boolean; origin?: string[] }) => {
        let profile = name;
        let input: { fields: Record<string, string>; origins?: string[] };
        if (options.stdinJson) {
            if (!profile) throw new Error("Provide the profile name");
            input = await credentialInput();
        } else {
            const prompted = await promptCredentials(name);
            profile = prompted.profile;
            input = { fields: prompted.fields };
        }
        const result = await addProfile(profile!, input.fields, options.origin ?? input.origins) as Parameters<typeof ui.renderProfileAdded>[0];
        await print(result, () => ui.renderProfileAdded(result));
    });
credentials.command("list")
    .description("list profiles and field names, never values")
    .action(async () => {
        const profiles = await listProfiles();
        await print({ profiles }, () => ui.renderProfiles(profiles));
    });
credentials.command("remove")
    .description("delete a profile")
    .argument("<profile>")
    .action(async (name: string) => {
        const result = await removeProfile(name) as Parameters<typeof ui.renderProfileRemoved>[0];
        await print(result, () => ui.renderProfileRemoved(result));
    });

const browseCommand = program.command("browse").description("drive a persistent exploration browser").helpGroup("Write Specs by hand:");
async function browseAction(action: string, args: { url?: string; ref?: string; value?: string; secret?: string; headed?: boolean }) {
    const workspace = await workspaceDirectory();
    const config = await loadConfig(workspace);
    const task = () => browse(action, { workspace, baseUrl: config.baseUrl, ...args }) as Promise<Record<string, unknown>>;
    const result = action === "open" ? await working("Opening the browser", task) : await task();
    await print(result, () => ui.renderBrowse(action, result));
}
browseCommand.command("open").description("open a page and print its snapshot").argument("[url]").option("--headed", "show the browser window")
    .action((url: string | undefined, options: { headed?: boolean }) => browseAction("open", { url, headed: options.headed }));
browseCommand.command("snapshot").description("print the accessibility tree with element refs")
    .action(() => browseAction("snapshot", {}));
browseCommand.command("inspect").description("show attributes and locator candidates for an element").argument("<ref>")
    .action((ref: string) => browseAction("inspect", { ref }));
browseCommand.command("click").description("click an element").argument("<ref>")
    .action((ref: string) => browseAction("click", { ref }));
browseCommand.command("fill").description("type into a field").argument("<ref>").argument("[text]")
    .option("--secret <profile.field>", "type a stored credential without revealing it")
    .action((ref: string, value: string | undefined, options: { secret?: string }) => browseAction("fill", { ref, value, secret: options.secret }));
browseCommand.command("close").description("close the exploration browser")
    .action(() => browseAction("close", {}));

const hideHelpCommand = (command: Command): void => { command.helpCommand(false); command.commands.forEach(hideHelpCommand); };
hideHelpCommand(program);

async function main(): Promise<void> {
    const raw = process.argv.slice(2);
    if (raw[0] === "--browse-daemon") return startBrowserDaemon(raw[1]!, raw[2]!, raw.includes("--headed"));
    if (raw[0] === "--mcp") return runMcpServer(raw[1]!, raw[2]!);
    if (raw[0] === "--chat-worker") return runChatWorker(raw[1]!, raw[2]!, raw[3]!);
    if (json && (raw.includes("--help") || raw.includes("-h") || raw.every((item) => item === "--json"))) {
        stdout.write(JSON.stringify({ help: program.helpInformation(), chatReplySchema: chatReplyJsonSchema }) + "\n");
        return;
    }
    if (json && (raw.includes("--version") || raw.includes("-v"))) { stdout.write(JSON.stringify({ version: CLI_VERSION }) + "\n"); return; }
    if (!raw.length) { program.outputHelp(); return; }
    await program.parseAsync(process.argv);
}

main().catch(async (error) => {
    if (error instanceof CommanderError) {
        if (["commander.helpDisplayed", "commander.version", "commander.help"].includes(error.code)) return;
        process.exitCode = error.exitCode || 1;
        if (json) {
            const message = error.message.replace(/^error: /, "");
            const id = process.argv.slice(2).find((item) => /^c-[a-f0-9]{8}$/.test(item)) ?? "";
            await print(isChatCommand ? chatReplySchema.parse({ id, status: "failed", message, error: message }) : { ok: false, error: message }, () => "");
        }
        return;
    }
    let message = error instanceof Error ? error.message : String(error);
    if (!json && error instanceof RemoteError && error.detail?.code === "revision_conflict") {
        message += `\nConflicting paths:\n${error.detail.conflicts.map((conflict) => `  ${conflict.path}`).join("\n")}\nRun ${error.detail.command}, resolve the conflicts, then publish again.`;
    }
    let safe: string;
    try { safe = scrubCi(await scrubTokens(await scrub(message))); } catch { safe = "Could not read saved credentials securely; check SPECBOOK_HOME and file permissions"; }
    if (json) {
        const raw = process.argv.slice(2);
        const id = raw.find((item) => /^c-[a-f0-9]{8}$/.test(item)) ?? "";
        const detail = error instanceof RemoteError ? error.detail : undefined;
        stdout.write(scrubCi(redactTokens(JSON.stringify(isChatCommand ? chatReplySchema.parse({ id, status: "failed", message: safe, error: safe }) : { ok: false, error: safe, ...detail }))) + "\n");
    } else stderr.write(ui.failure(safe) + "\n");
    process.exitCode = 1;
});
