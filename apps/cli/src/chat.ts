import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { prepareAgentInvocation, executeAgent, confirmedResults, conversationInstructions, type Agent } from "./agent.js";
import { emptyAgentState, readAgentState, type AgentState } from "./mcp.js";
import { containsSecret, scrub } from "./credentials.js";
import { detectAgents, loadConfig, safeWorkspacePath, specDirectories } from "./workspace.js";
import { chatIdSchema, chatReplySchema, conversationSchema, outcomeSchema, type ChatReply, type ChatSpec, type Conversation } from "./chat-model.js";

const chatPath = (id: string, file: string) => `chats/${chatIdSchema.parse(id)}/${file}`;

async function removeAuthentication(workspace: string, id: string): Promise<void> {
    for (const file of ["claude-home/.credentials.json", "codex-home/auth.json"]) {
        await fs.rm(await safeWorkspacePath(workspace, chatPath(id, `brain/${file}`), true), { force: true });
    }
}

function restoreMetadata(original: unknown, redacted: unknown): unknown {
    if (Array.isArray(original) && Array.isArray(redacted)) return original.map((value, index) => restoreMetadata(value, redacted[index]));
    if (original && redacted && typeof original === "object" && typeof redacted === "object") {
        return Object.fromEntries(Object.entries(original).map(([key, value]) => [key,
            /^(?:type|role|status|timestamp|cwd|id|uuid)$|(?:_id|Id|Uuid)$/i.test(key) ? value : restoreMetadata(value, (redacted as Record<string, unknown>)[key]),
        ]));
    }
    return redacted;
}

async function redactBrainHistory(workspace: string, id: string): Promise<void> {
    const session = await safeWorkspacePath(workspace, chatPath(id, "brain"));
    for (const entry of await fs.readdir(session, { recursive: true, withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new Error("Symlinks are not allowed in the brain session directory");
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        const file = await safeWorkspacePath(workspace, path.relative(workspace, path.join(entry.parentPath, entry.name)));
        const original = await fs.readFile(file, "utf8");
        const lines = [];
        for (const line of original.split("\n")) {
            const safe = await scrub(line);
            if (safe === line) { lines.push(line); continue; }
            try { lines.push(JSON.stringify(restoreMetadata(JSON.parse(line), JSON.parse(safe)))); }
            catch { lines.push(safe); }
        }
        const redacted = lines.join("\n");
        if (redacted !== original) {
            const temporary = `${file}.${randomUUID()}.tmp`;
            await fs.writeFile(temporary, redacted, { mode: 0o600, flag: "wx" });
            try { await fs.rename(temporary, file); }
            finally { await fs.rm(temporary, { force: true }); }
        }
    }
}

async function writeJson(workspace: string, relative: string, value: unknown): Promise<void> {
    const target = await safeWorkspacePath(workspace, relative, true);
    const temporary = await safeWorkspacePath(workspace, `${relative}.${randomUUID()}.tmp`, true);
    try {
        await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
        await safeWorkspacePath(workspace, relative, true);
        await fs.rename(temporary, target);
    } finally { await fs.rm(temporary, { force: true }); }
}

async function saveConversation(workspace: string, state: Conversation): Promise<void> {
    state.updatedAt = new Date().toISOString();
    state.reply = await redactReply(state.reply);
    for (const entry of state.history) {
        entry.message = await scrub(entry.message);
        if (entry.reply) entry.reply = await redactReply(entry.reply);
    }
    await writeJson(workspace, chatPath(state.id, "conversation.json"), conversationSchema.parse(state));
}

async function readConversation(workspace: string, id: string): Promise<Conversation> {
    const file = await safeWorkspacePath(workspace, chatPath(id, "conversation.json")).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") throw Object.assign(new Error(`No conversation ${id} in this workspace. Run specbook chats to list them.`), { code: "ENOENT" });
        throw error;
    });
    return conversationSchema.parse(JSON.parse(await fs.readFile(file, "utf8")));
}

function processIdentity(pid: number): string | undefined {
    if (process.platform !== "linux") return undefined;
    try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        return fields[0] === "Z" ? undefined : fields[19];
    } catch { return undefined; }
}

function isAlive(pid: number, identity?: string): boolean {
    try {
        process.kill(pid, 0);
        const current = processIdentity(pid);
        return process.platform !== "linux" || !!current && (!identity || identity === current);
    }
    catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

async function withStateLock<T>(workspace: string, id: string, action: () => Promise<T>): Promise<T> {
    const file = await safeWorkspacePath(workspace, chatPath(id, "state.lock"), true);
    for (let attempt = 0; attempt < 250; attempt++) {
        let handle;
        try { handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            const owner = Number(await fs.readFile(await safeWorkspacePath(workspace, chatPath(id, "state.lock")), "utf8").catch(() => ""));
            const stat = await fs.lstat(file).catch(() => undefined);
            if (owner ? !isAlive(owner) : stat && Date.now() - stat.mtimeMs > 15_000) await fs.rm(file, { force: true });
            await delay(20);
            continue;
        }
        try { await handle.writeFile(String(process.pid)); return await action(); }
        finally { await handle.close(); await fs.rm(file, { force: true }); }
    }
    throw new Error("The conversation state is busy. Retry in a moment.");
}

async function finishLocked(workspace: string, state: Conversation, reply: ChatReply): Promise<void> {
    state.reply = await redactReply(reply);
    const accumulated = new Map(state.specs.map((spec) => [spec.path, spec]));
    for (const spec of state.reply.specs ?? []) accumulated.set(spec.path, { ...spec, created: spec.created || accumulated.get(spec.path)?.created || false });
    state.specs = [...accumulated.values()];
    if (reply.status === "done" || reply.status === "waiting_for_selection") {
        delete state.pendingSelection;
        delete state.pendingProposalRuns;
    } else if (state.turn?.selected) {
        state.pendingSelection = state.turn.selected;
        const brain = await safeWorkspacePath(workspace, chatPath(state.id, "brain"));
        state.pendingProposalRuns = (await readAgentState(brain)).proposalRuns ?? {};
    }
    state.history.push({ role: "specbook", message: state.reply.message, at: new Date().toISOString(), reply: state.reply });
    delete state.turn;
    await saveConversation(workspace, state);
}

async function finish(workspace: string, state: Conversation, reply: ChatReply): Promise<void> {
    await withStateLock(workspace, state.id, async () => {
        const current = await readConversation(workspace, state.id);
        if (current.turn?.id === state.turn?.id) await finishLocked(workspace, current, reply);
    });
}

async function recover(workspace: string, state: Conversation): Promise<Conversation> {
    if (state.reply.status !== "working" || !state.turn) return state;
    if (state.turn.pid && isAlive(state.turn.pid, state.turn.workerIdentity)) return state;
    // Give the detached worker time to claim its turn after the launcher exits.
    if (!state.turn.pid && Date.now() - Date.parse(state.turn.startedAt) < 15_000) return state;
    const turnId = state.turn.id;
    return withStateLock(workspace, state.id, async () => {
        const latest = await readConversation(workspace, state.id);
        if (latest.reply.status !== "working" || latest.turn?.id !== turnId || latest.turn.pid && isAlive(latest.turn.pid, latest.turn.workerIdentity)) return latest;
        const error = "The conversation worker stopped before saving its reply. Send your reply again to retry; completed Specs and runs remain on disk.";
        if (latest.turn?.brainPid && isAlive(latest.turn.brainPid, latest.turn.brainIdentity)) {
            try {
                if (process.platform === "win32") process.kill(latest.turn.brainPid, "SIGTERM");
                else {
                    process.kill(-latest.turn.brainPid, "SIGTERM");
                    await delay(3000);
                    try { process.kill(-latest.turn.brainPid, "SIGKILL"); }
                    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
                }
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
        }
        let reply: ChatReply = { id: state.id, status: "failed", message: error, error };
        if (latest.turn?.baseline) {
            try {
                const after = await readAgentState(await safeWorkspacePath(workspace, chatPath(state.id, "brain")));
                const baseline = latest.turn.baseline;
                const before: AgentState = { attempts: {}, writes: after.writes, runs: after.runs.slice(0, baseline.runs), writeEvents: after.writeEvents?.slice(0, baseline.writes) };
                reply = await completedReply(workspace, latest, before, after, new Set(baseline.existing));
            } catch { /* A worker without a typed outcome must be retried. */ }
        }
        await removeAuthentication(workspace, state.id);
        await redactBrainHistory(workspace, state.id);
        await finishLocked(workspace, latest, reply);
        return latest;
    });
}

export interface ChatOptions { agent?: Agent; timeoutMs?: number; noWait?: boolean; wait?: boolean; select?: string; signal?: AbortSignal }

function timeout(options: ChatOptions): number {
    const value = options.timeoutMs ?? 600_000;
    if (!Number.isFinite(value) || value < 1000 || value > 3_600_000) throw new Error("--timeout must be between 1 and 3600 seconds");
    return value;
}

export async function waitForReply(workspace: string, id: string, options: ChatOptions = {}): Promise<ChatReply> {
    const deadline = Date.now() + timeout(options);
    while (true) {
        const state = await recover(workspace, await readConversation(workspace, id));
        if (state.reply.status !== "working" || Date.now() >= deadline || options.signal?.aborted) return state.reply;
        await delay(Math.min(250, Math.max(1, deadline - Date.now())));
    }
}

async function launch(workspace: string, state: Conversation): Promise<void> {
    const turnId = state.turn!.id;
    const child = spawn(process.execPath, [...process.execArgv, path.resolve(process.argv[1]), "--chat-worker", workspace, state.id, turnId], {
        cwd: path.dirname(workspace), env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("SPECBOOK_SECRET_"))),
        detached: true, stdio: "ignore",
    });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
}

export async function sendMessage(workspace: string, args: string[], options: ChatOptions = {}): Promise<ChatReply> {
    timeout(options);
    if (options.wait && (options.noWait || options.select !== undefined || args.length !== 1)) throw new Error("Use chat <id> --wait without a reply, --select or --no-wait");
    if (options.select !== undefined && args.length !== 1) throw new Error("Use chat <id> --select 1,2 without a text reply");
    if (!args.length || args.length > 2) throw new Error('Use chat "<message>" or chat <id> "<reply>"');
    const existing = args.length === 2 || options.wait || options.select !== undefined || chatIdSchema.safeParse(args[0]).success;
    let state: Conversation;
    let request: string;
    if (existing) {
        state = await recover(workspace, await readConversation(workspace, args[0]));
        if (options.agent && options.agent !== state.agent) throw new Error(`This conversation uses ${state.agent}; start a new chat to use ${options.agent}`);
        if (options.wait) return waitForReply(workspace, state.id, options);
        if (state.reply.status === "working") return state.reply;
        if (options.select === undefined && !args[1]) throw new Error('Provide a reply or use --wait or --select');
        request = args[1] ?? "";
    } else {
        if (options.wait || options.select !== undefined) throw new Error("Provide a conversation id");
        if (!args[0].trim() || args[0].length > 20_000) throw new Error("Provide a message of 1–20000 characters");
        if (await containsSecret(args[0])) throw new Error("Credential values cannot be sent through a conversation. Use specbook credentials add <profile> and reply done.");
        const config = await loadConfig(workspace);
        const agent = options.agent ?? config.agent ?? detectAgents()[0];
        if (!agent) throw new Error("Install and authenticate Claude Code or Codex, then select it with --agent");
        const chats = await safeWorkspacePath(workspace, "chats", true);
        await fs.mkdir(chats, { recursive: true, mode: 0o700 });
        let id: string;
        while (true) {
            id = `c-${randomBytes(4).toString("hex")}`;
            try { await fs.mkdir(await safeWorkspacePath(workspace, `chats/${id}`, true), { mode: 0o700 }); break; }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        }
        const at = new Date().toISOString();
        state = { version: 1, id, agent, createdAt: at, updatedAt: at, history: [], specs: [], reply: { id, status: "working", message: "Specbook is working. Use specbook chat " + id + " --wait to read the reply." } };
        await fs.mkdir(await safeWorkspacePath(workspace, chatPath(id, "brain"), true), { mode: 0o700 });
        await writeJson(workspace, chatPath(id, "brain/state.json"), emptyAgentState());
        request = args[0];
    }
    let selected: NonNullable<Conversation["turn"]>["selected"];
    if (options.select !== undefined) {
        if (state.reply.status !== "waiting_for_selection" || !state.reply.proposals) throw new Error("This conversation is not waiting for a Spec selection");
        if (!/^[1-9]\d*(?:,[1-9]\d*)*$/.test(options.select)) throw new Error("--select must contain positive proposal numbers separated by commas, such as 1,2");
        const numbers = [...new Set(options.select.split(",").map(Number))];
        selected = numbers.map((number) => {
            const proposal = state.reply.proposals!.find((proposal) => proposal.number === number);
            if (!proposal) throw new Error(`Unknown proposal number ${number}`);
            return proposal;
        });
        request = selectionRequest(selected);
    } else if (state.pendingSelection) {
        selected = state.pendingSelection;
        request = `${request}\n\n${selectionRequest(selected)}`;
    }
    if (!request.trim() || request.length > 20_000) throw new Error("Provide a message of 1–20000 characters");
    if (await containsSecret(request)) throw new Error("Credential values cannot be sent through a conversation. Use specbook credentials add <profile> and reply done.");
    try {
        const accepted = await withStateLock(workspace, state.id, async () => {
            if (existing) {
                const current = await readConversation(workspace, state.id);
                if (current.reply.status === "working") return current.reply;
                if (current.updatedAt !== state.updatedAt) return current.reply;
                state = current;
            }
            const at = new Date().toISOString();
            state.turn = { id: randomUUID(), request, startedAt: at, ...(selected ? { selected } : {}) };
            if (options.select !== undefined) delete state.pendingProposalRuns;
            state.history.push({ role: "user", message: request, at });
            state.reply = { id: state.id, status: "working", message: `Specbook is working. Use specbook chat ${state.id} --wait to read the reply.` };
            await saveConversation(workspace, state);
            return undefined;
        });
        if (accepted) return accepted;
        await launch(workspace, state);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await finish(workspace, state, { id: state.id, status: "failed", message: `Could not start the conversation turn: ${message}`, error: message });
        return (await readConversation(workspace, state.id)).reply;
    }
    return options.noWait ? state.reply : waitForReply(workspace, state.id, options);
}

export async function listConversations(workspace: string) {
    const directory = await safeWorkspacePath(workspace, "chats", true);
    const entries = await fs.readdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
    const conversations = [];
    for (const id of entries) {
        if (!chatIdSchema.safeParse(id).success) continue;
        const found = await readConversation(workspace, id).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
        if (!found) continue;
        const state = await recover(workspace, found);
        conversations.push({ id, status: state.reply.status, updatedAt: state.updatedAt, agent: state.agent, specs: state.specs });
    }
    return { conversations: conversations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) };
}

async function turnSpecs(workspace: string, before: AgentState, after: AgentState, existing: Set<string>, included: string[] = []): Promise<ChatSpec[]> {
    const activePaths = new Set(after.runs.slice(before.runs.length).flatMap((run) => run.results.map((result) => result.path)));
    for (const relative of included) activePaths.add(relative);
    const writes = after.writeEvents?.slice(before.writeEvents?.length ?? 0) ?? after.writes.filter((file) => !before.writes.includes(file));
    const writtenPaths = new Set(writes.filter((file) => /\/spec\.(ts|yml)$/.test(file)).map((file) => path.posix.dirname(file)));
    const results = (await confirmedResults(workspace, after)).filter((result) => activePaths.has(result.path));
    const specs: ChatSpec[] = results.map((result) => {
        const actual = after.runs.flatMap((run) => run.results).filter((item) => item.path === result.path).at(-1)!;
        return { ...result, status: result.status as ChatSpec["status"], title: actual.title, created: writtenPaths.has(result.path) && !existing.has(result.path) };
    });
    for (const relative of writtenPaths) {
        if (specs.some((spec) => spec.path === relative)) continue;
        specs.push({ path: relative, title: relative, created: !existing.has(relative), status: "not_run" });
    }
    return specs;
}

function selectionRequest(selected: NonNullable<Conversation["turn"]>["selected"]): string {
    return `Selected Spec proposals: ${JSON.stringify(selected)}. Create or reuse coverage for EACH selected proposal, check locators, run each Spec with run_spec({path,proposalNumber:<selected number>}) and correct incorrect tests within THREE total runs per Spec in this turn. End with report_done only after every selected behavior has a recorded run result. Preserve the requested contracts; report application defects without weakening assertions.`;
}

async function completedReply(workspace: string, state: Conversation, before: AgentState, after: AgentState, existing: Set<string>): Promise<ChatReply> {
    const outcome = outcomeSchema.parse(JSON.parse(await fs.readFile(await safeWorkspacePath(workspace, chatPath(state.id, "brain/outcome.json")), "utf8")));
    const reply: ChatReply = { id: state.id, ...outcome };
    const specs = await turnSpecs(workspace, before, after, existing, state.turn?.selected ? Object.values(after.proposalRuns ?? {}) : []);
    for (const spec of specs) spec.created ||= state.specs.find((previous) => previous.path === spec.path)?.created ?? false;
    if (specs.length || outcome.status === "done") {
        reply.specs = specs;
        reply.evidencePaths = [...new Set(specs.flatMap((spec) => [spec.evidencePath, spec.report].filter((file): file is string => !!file)))];
    }
    if (outcome.status === "done" && state.turn?.selected?.some((proposal) => !specs.some((spec) => spec.path === after.proposalRuns?.[String(proposal.number)] && spec.status !== "not_run"))) throw new Error("The brain reported done before running every selected Spec. Reply to request the remaining coverage.");
    return reply;
}

export async function runChatWorker(workspace: string, id: string, turnId: string): Promise<void> {
    let state = await withStateLock(workspace, id, async () => {
        const current = await readConversation(workspace, id);
        if (current.reply.status !== "working" || current.turn?.id !== turnId || current.turn.pid) return undefined;
        current.turn.pid = process.pid;
        current.turn.workerIdentity = processIdentity(process.pid);
        await saveConversation(workspace, current);
        return current;
    });
    if (!state) return;
    const session = await safeWorkspacePath(workspace, chatPath(id, "brain"));
    const cancellation = new AbortController();
    const cancel = () => cancellation.abort(new Error("The conversation worker was cancelled. Send another reply to retry."));
    process.once("SIGTERM", cancel);
    process.once("SIGINT", cancel);
    const limit = setTimeout(() => cancellation.abort(new Error("The brain exceeded the one-hour worker limit. Completed Specs and evidence remain; send another reply to retry.")), 3_600_000);
    let before = emptyAgentState();
    let existing = new Set<string>();
    let reply: ChatReply;
    try {
        before = await readAgentState(session);
        existing = new Set(await specDirectories(workspace));
        await writeJson(workspace, chatPath(id, "brain/state.json"), { ...before, attempts: {}, proposalRuns: state.pendingProposalRuns ?? {} });
        await fs.rm(await safeWorkspacePath(workspace, chatPath(id, "brain/outcome.json"), true), { force: true });
        await writeJson(workspace, chatPath(id, "brain/turn.json"), { id: turnId, ...(state.turn!.selected ? { selected: state.turn!.selected } : {}) });
        await withStateLock(workspace, id, async () => {
            const current = await readConversation(workspace, id);
            if (current.turn?.id !== turnId) throw new Error("The conversation turn was replaced");
            current.turn.baseline = { runs: before.runs.length, writes: before.writeEvents?.length ?? 0, existing: [...existing] };
            await saveConversation(workspace, current);
        });
        const config = await loadConfig(workspace);
        await redactBrainHistory(workspace, id);
        const invocation = await prepareAgentInvocation(state.agent, workspace, session, conversationInstructions(config.baseUrl), cancellation.signal, state.brainSessionId);
        const execution = await executeAgent(invocation, state.turn!.request, cancellation.signal, async (brainSessionId) => withStateLock(workspace, id, async () => {
            const current = await readConversation(workspace, id);
            if (current.turn?.id !== turnId) throw new Error("The conversation turn was replaced");
            current.brainSessionId = brainSessionId;
            await saveConversation(workspace, current);
        }), async (brainPid) => withStateLock(workspace, id, async () => {
            const current = await readConversation(workspace, id);
            if (current.turn?.id !== turnId) throw new Error("The conversation turn was replaced");
            current.turn.brainPid = brainPid;
            current.turn.brainIdentity = processIdentity(brainPid);
            await saveConversation(workspace, current);
        }));
        cancellation.signal.throwIfAborted();
        if (execution.code !== 0) throw new Error(execution.errors || `The ${state.agent} brain exited with code ${execution.code}. Check its login and retry.`);
        if (!execution.sessionId && !state.brainSessionId) throw new Error("The brain did not return a resumable session id. Update the selected agent and retry.");
        reply = await completedReply(workspace, state, before, await readAgentState(session), existing);
    } catch (error) {
        const detail = (cancellation.signal.reason instanceof Error ? cancellation.signal.reason : error) as Error;
        const message = await scrub(detail instanceof Error ? detail.message : String(detail));
        reply = { id, status: "failed", message: `The turn could not complete: ${message}\nCheck the selected agent's installation and authentication, then reply to retry.`, error: message };
        try {
            reply.specs = await turnSpecs(workspace, before, await readAgentState(session), existing);
            reply.evidencePaths = reply.specs.flatMap((spec) => [spec.evidencePath, spec.report].filter((file): file is string => !!file));
        } catch { /* Completed run files still remain available on disk. */ }
    } finally {
        clearTimeout(limit);
        process.removeListener("SIGTERM", cancel);
        process.removeListener("SIGINT", cancel);
        await removeAuthentication(workspace, id);
        await redactBrainHistory(workspace, id);
    }
    state = await readConversation(workspace, id);
    if (state.turn?.id === turnId) await finish(workspace, state, reply);
}

export async function redactReply(reply: ChatReply): Promise<ChatReply> {
    const safe = structuredClone(reply);
    safe.message = await scrub(safe.message);
    if (safe.error) safe.error = await scrub(safe.error);
    if (safe.pendingAction?.type === "question") safe.pendingAction.question = await scrub(safe.pendingAction.question);
    for (const proposal of safe.proposals ?? []) {
        proposal.title = await scrub(proposal.title);
        proposal.why = await scrub(proposal.why);
        proposal.feature = await scrub(proposal.feature);
    }
    for (const spec of safe.specs ?? []) {
        spec.title = await scrub(spec.title);
        if (spec.failReason) spec.failReason = await scrub(spec.failReason);
    }
    return chatReplySchema.parse(safe);
}
