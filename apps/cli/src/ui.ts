import path from "node:path";
import pc from "picocolors";
import type { ChatReply, ChatSpec } from "./chat-model";
import type { LocalRun } from "./run";
import type { LocatorCheck } from "./locators";
import type { login, logout, connect, pull, publish } from "./remote";
import type { CiResult } from "./ci";

type Status = "passed" | "failed" | "error" | "changed_after_run" | "not_run";

const icons: Record<Status, string> = {
    passed: pc.green("✔"), failed: pc.red("✖"), error: pc.yellow("▲"), changed_after_run: pc.yellow("●"), not_run: pc.dim("○"),
};
const badges: Record<string, (text: string) => string> = {
    passed: (text) => pc.bgGreen(pc.black(text)), failed: (text) => pc.bgRed(pc.black(text)), error: (text) => pc.bgYellow(pc.black(text)),
    done: (text) => pc.bgGreen(pc.black(text)), working: (text) => pc.bgBlue(pc.black(text)),
    waiting_for_reply: (text) => pc.bgCyan(pc.black(text)), waiting_for_selection: (text) => pc.bgCyan(pc.black(text)),
    needs_credentials: (text) => pc.bgYellow(pc.black(text)),
};
const statusLabels: Record<string, string> = {
    working: "working", waiting_for_reply: "question", waiting_for_selection: "proposals",
    needs_credentials: "needs login", done: "done", failed: "failed", passed: "passed", error: "error",
    changed_after_run: "changed", not_run: "not run",
};
const statusColors: Record<string, (text: string) => string> = {
    passed: pc.green, done: pc.green, failed: pc.red, error: pc.yellow, needs_credentials: pc.yellow,
    changed_after_run: pc.yellow, working: pc.blue, waiting_for_reply: pc.cyan, waiting_for_selection: pc.cyan, not_run: pc.dim,
};

export const brand = `${pc.bold("specbook")}`;
const badge = (status: string) => (badges[status] ?? ((text: string) => pc.inverse(text)))(` ${(statusLabels[status] ?? status).toUpperCase()} `);
const colored = (status: string) => (statusColors[status] ?? pc.dim)(statusLabels[status] ?? status);
const icon = (status: string) => icons[status as Status] ?? pc.dim("•");
const width = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "").length;
const pad = (text: string, size: number) => text + " ".repeat(Math.max(0, size - width(text)));
const columns = () => Math.min(process.stdout.columns || 100, 100);
const wrap = (text: string, size: number) => text.split("\n").map((line) => {
    const out: string[] = [];
    let current = "";
    for (const word of line.split(" ")) {
        if (current && width(current) + 1 + width(word) > size) { out.push(current); current = word; }
        else current = current ? `${current} ${word}` : word;
    }
    return [...out, current].join("\n");
}).join("\n");
// Agents reply in light markdown; style the inline marks instead of printing them.
const markdown = (text: string) => text.replace(/\*\*([^*\n]+)\*\*/g, (_, bold) => pc.bold(bold)).replace(/`([^`\n]+)`/g, (_, code) => pc.cyan(code));
const indent = (text: string, spaces = 2) => text.split("\n").map((line) => line ? " ".repeat(spaces) + line : line).join("\n");
export const relative = (file: string) => {
    const rel = path.relative(process.cwd(), file);
    return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : file;
};
const duration = (ms: number | null | undefined) => ms == null ? "" : ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round(ms % 60_000 / 1000)}s`;
const ago = (iso: string) => {
    const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    if (seconds < 60) return "just now";
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86_400)}d ago`;
};
const fields = (rows: [string, string | undefined][]) => {
    const present = rows.filter((row): row is [string, string] => !!row[1]);
    const size = Math.max(...present.map(([label]) => label.length));
    return present.map(([label, value]) => `  ${pc.dim(label.padEnd(size))}  ${value}`).join("\n");
};
const command = (text: string) => pc.cyan(text);
const next = (...commands: string[]) => `\n${pc.dim("Next")}\n${commands.map((line) => `  ${pc.dim("$")} ${command(line)}`).join("\n")}`;
const table = (rows: string[][]) => {
    const sizes = rows[0]!.map((_, column) => Math.max(...rows.map((row) => width(row[column] ?? ""))));
    return rows.map((row) => "  " + row.map((cell, column) => column === row.length - 1 ? cell : pad(cell, sizes[column]!)).join("   ")).join("\n");
};
// The full Playwright call log stays in the report; the terminal shows the assertion.
const briefReason = (reason: string | null | undefined) => {
    if (!reason) return "Failed without a reason";
    const lines = reason.split("\nCall log:")[0]!.trim().split("\n").filter((line) => line.trim());
    return lines.slice(0, 6).join("\n") + (lines.length > 6 ? pc.dim("\n…") : "");
};
export const success = (text: string) => `${pc.green("✔")} ${text}`;
export const failure = (text: string) => `${pc.red("✖")} ${text}`;

export function renderInit(result: { workspace: string; config: { baseUrl: string; agent?: string }; agents: string[] }) {
    const agent = result.config.agent
        ? `${result.config.agent}${result.agents.length > 1 ? pc.dim(` (found ${result.agents.join(", ")})`) : ""}`
        : pc.yellow("none found; install claude or codex to use specbook chat");
    return [
        success(`Workspace ready in ${pc.bold(relative(result.workspace))}`), "",
        fields([["Base URL", result.config.baseUrl], ["Agent", agent], ["Skill", ".claude/skills/specbook · .agents/skills/specbook"]]),
        next(`specbook chat "describe a behavior to cover"`, `specbook credentials add <profile>`),
    ].join("\n");
}

export function renderNewSpec(result: { path: string; title: string; feature: string }, workspace: string) {
    const directory = relative(path.join(workspace, result.path));
    return [
        success(`Created ${pc.bold(result.title)} ${pc.dim(`· ${result.feature}`)}`), "",
        fields([["Contract", `${directory}/spec.yml`], ["Test", `${directory}/spec.ts`]]),
        next(`specbook spec check ${result.path}`, `specbook run ${result.path}`),
    ].join("\n");
}

const locatorLine = (locator: LocatorCheck) => {
    const detail = locator.status === "matched" ? "" : locator.status === "ambiguous" ? pc.yellow(` matches ${locator.count} elements`)
        : locator.status === "missing" ? pc.red(" matches nothing") : pc.red(` ${locator.error ?? "could not be checked"}`);
    const mark = locator.status === "matched" ? pc.green("✔") : locator.status === "ambiguous" ? pc.yellow("▲") : pc.red("✖");
    return `    ${mark} ${pc.dim(`L${locator.line}`)} ${locator.locator}${detail}`;
};

export function renderCheck(result: { ok: boolean; specs: { path: string; ok: boolean; error?: string; locators: LocatorCheck[] }[] }) {
    if (!result.specs.length) return failure("No Specs found. Create one with specbook spec new or specbook chat.");
    const valid = result.specs.filter((spec) => spec.ok).length;
    const lines = result.specs.map((spec) => {
        const head = `  ${spec.ok ? pc.green("✔") : pc.red("✖")} ${spec.path}`;
        if (spec.error) return `${head}\n${indent(pc.red(spec.error), 6)}`;
        const problems = spec.locators.filter((locator) => locator.status !== "matched");
        const summary = spec.locators.length ? pc.dim(` ${spec.locators.length - problems.length}/${spec.locators.length} locators on the open page`) : "";
        return [head + summary, ...problems.map(locatorLine)].join("\n");
    });
    const live = result.specs.some((spec) => spec.locators.length);
    return [
        `${badge(result.ok ? "passed" : "failed")} ${valid} of ${result.specs.length} Spec${result.specs.length === 1 ? "" : "s"} valid`, "",
        ...lines,
        live ? `\n${pc.dim("Locators were checked against the page open in specbook browse; later steps may target other pages.")}` : "",
    ].filter((line, index, all) => line !== "" || index !== all.length - 1).join("\n");
}

export function renderRun(run: LocalRun) {
    const passed = run.results.filter((result) => result.status === "passed").length;
    const groups = new Map<string, LocalRun["results"]>();
    for (const result of run.results) groups.set(result.feature, [...groups.get(result.feature) ?? [], result]);
    const titleSize = Math.min(64, Math.max(...run.results.map((result) => result.title.length)));
    const body = [...groups].map(([feature, results]) => [
        `  ${pc.bold(feature)}`,
        ...results.map((result) => {
            const line = `    ${icon(result.status)} ${pad(result.title, titleSize)}  ${pc.dim(duration(result.durationMs))}`;
            if (result.status === "passed") return line;
            const step = result.failedStep ? `${pc.dim("at step")} ${result.failedStep}\n` : "";
            return `${line}\n${indent(step + pc.red(briefReason(result.failReason)), 8)}`;
        }),
    ].join("\n"));
    return [
        `${badge(run.status)} ${passed} of ${run.results.length} Spec${run.results.length === 1 ? "" : "s"} passed ${pc.dim(`· ${duration(run.durationMs)} · ${run.baseUrl}`)}`, "",
        ...body.flatMap((group, index) => index ? ["", group] : [group]), "",
        fields([["Report", relative(run.report)], ["Evidence", relative(run.directory)]]),
    ].join("\n");
}

export function renderReport(result: { run: string; report: string }) {
    return [success(`Report for run ${pc.dim(result.run)}`), "", fields([["File", relative(result.report)]])].join("\n");
}

export function renderProfiles(profiles: { name: string; fields: string[]; origins: string[] }[]) {
    if (!profiles.length) return `${pc.dim("No credential profiles yet.")}\n${next("specbook credentials add <profile>")}`;
    return [
        pc.bold(`Credential profiles ${pc.dim(`(${profiles.length})`)}`), "",
        table([[pc.dim("PROFILE"), pc.dim("FIELDS"), pc.dim("ORIGINS")], ...profiles.map((profile) => [pc.bold(profile.name), profile.fields.join(", "), profile.origins.join(", ") || pc.dim("base URL")])]),
        `\n${pc.dim("Values live in a private file on this machine and are never printed.")}`,
    ].join("\n");
}

export function renderProfileAdded(result: { profile: string; fields: string[]; origins: string[] }) {
    return [
        success(`Saved profile ${pc.bold(result.profile)}`), "",
        fields([["Fields", result.fields.join(", ")], ["Origins", result.origins.join(", ") || pc.dim("the workspace base URL")], ["Use in a Spec", pc.cyan(`secret("${result.profile}", "${result.fields[0]}")`)]]),
    ].join("\n");
}

export function renderProfileRemoved(result: { profile: string; removed: boolean }) {
    return result.removed ? success(`Removed profile ${pc.bold(result.profile)}`) : `${pc.dim("No profile named")} ${pc.bold(result.profile)}`;
}

export function renderBrowse(action: string | undefined, result: Record<string, unknown>) {
    if (result.closed) return success("Closed the exploration browser");
    if (typeof result.snapshot === "string") {
        const tree = result.snapshot.match(/```yaml\n([\s\S]*?)\n```/)?.[1] ?? result.snapshot;
        const head = `${pc.bold(String(result.title || "Untitled page"))} ${pc.dim(String(result.url ?? ""))}`;
        const lines = tree.split("\n").map((line) => line.replace(/\[ref=([^\]]+)\]/g, (_, ref) => pc.cyan(`[${ref}]`)));
        return [head, "", ...lines].join("\n");
    }
    if (action === "inspect") {
        const { url, target, html, ancestors, computed, ...rest } = result as { url?: string; target?: string; html?: string; ancestors?: string[]; computed?: Record<string, string> };
        return [
            `${pc.bold(`Element ${target}`)} ${pc.dim(String(url ?? ""))}`,
            html ? `\n  ${pc.cyan(html)}` : "",
            ancestors?.length ? `\n${pc.dim("  Inside")}\n${[...ancestors].reverse().map((ancestor, index) => `  ${" ".repeat(index * 2)}${pc.dim("└")} ${ancestor}`).join("\n")}` : "",
            computed ? `\n${fields(Object.entries(computed))}` : "",
            Object.keys(rest).length ? `\n${indent(JSON.stringify(rest, null, 2))}` : "",
        ].filter(Boolean).join("\n");
    }
    return JSON.stringify(result, null, 2);
}

const chatSpec = (spec: ChatSpec) => {
    const line = `  ${icon(spec.status)} ${spec.title} ${pc.dim("·")} ${colored(spec.status)}${spec.created ? pc.dim(", new") : ""}`;
    const reason = spec.failReason && spec.status !== "passed" ? `\n${indent(pc.red(briefReason(spec.failReason)), 6)}` : "";
    const where = spec.report ?? spec.evidencePath;
    return `${line}${reason}${where ? `\n      ${pc.dim(relative(where))}` : ""}`;
};

export function renderReply(reply: ChatReply) {
    const out = [`${badge(reply.status)} ${pc.dim(`conversation ${reply.id}`)}`, "", indent(markdown(wrap(reply.message.trim(), columns() - 4)))];
    if (reply.proposals?.length) {
        out.push("", ...reply.proposals.map((proposal) => [
            `  ${pc.cyan(pc.bold(`${proposal.number}.`))} ${pc.bold(proposal.title)} ${pc.dim(`· ${proposal.feature}`)}`,
            indent(pc.dim(wrap(proposal.why, columns() - 7)), 5),
        ].join("\n")));
    }
    if (reply.specs?.length) out.push("", pc.bold("  Specs"), ...reply.specs.map(chatSpec));
    if (reply.status === "working") out.push(next(`specbook chat ${reply.id} --wait`));
    if (reply.status === "waiting_for_reply") out.push(next(`specbook chat ${reply.id} "<your answer>"`));
    if (reply.status === "waiting_for_selection") {
        const all = reply.proposals?.map((proposal) => proposal.number).join(",") ?? "1";
        out.push(next(`specbook chat ${reply.id} --select ${all}`, `specbook chat ${reply.id} "<ask for changes>"`));
    }
    if (reply.pendingAction?.type === "credentials") {
        out.push("", `  ${pc.yellow("▲")} Specbook needs the ${pc.bold(reply.pendingAction.profile)} login ${pc.dim(`(${reply.pendingAction.fields.join(", ")})`)}`,
            next(reply.pendingAction.command, `specbook chat ${reply.id} "done"`));
    }
    return out.join("\n");
}

export function renderConversations(result: { conversations: { id: string; status: string; updatedAt: string; agent: string; specs: ChatSpec[] }[] }) {
    if (!result.conversations.length) return `${pc.dim("No conversations yet.")}\n${next(`specbook chat "describe a behavior to cover"`)}`;
    const specs = (list: ChatSpec[]) => {
        if (!list.length) return pc.dim("none");
        const passed = list.filter((spec) => spec.status === "passed").length;
        return passed === list.length ? pc.green(`${passed} passed`) : `${pc.green(`${passed} passed`)} ${pc.red(`${list.length - passed} not passing`)}`;
    };
    return table([
        [pc.dim("ID"), pc.dim("STATUS"), pc.dim("AGENT"), pc.dim("UPDATED"), pc.dim("SPECS")],
        ...result.conversations.map((chat) => [pc.bold(chat.id), colored(chat.status), chat.agent, pc.dim(ago(chat.updatedAt)), specs(chat.specs)]),
    ]);
}

export function renderLogin(result: Awaited<ReturnType<typeof login>>) {
    return [success(`Logged in as ${pc.bold(result.user.name)}`), "", fields([["Server", result.url], ["Role", result.user.role], ["Default", "this server"]]), next("specbook connect <project>")].join("\n");
}

export function renderLogout(result: Awaited<ReturnType<typeof logout>>) {
    return [result.removed ? success(`Logged out of ${result.url}`) : pc.dim("No saved login to remove"), result.defaultUrl ? `\n${fields([["Default", result.defaultUrl]])}` : ""].join("");
}

export function renderConnect(result: Awaited<ReturnType<typeof connect>>) {
    return [success(`Connected to ${pc.bold(result.project.name)}`), "", fields([["Server", result.url], ["Project", result.project.id], ["Environment", result.environment]]), next("specbook pull", "specbook publish --run")].join("\n");
}

export function renderPull(result: Awaited<ReturnType<typeof pull>>) {
    const head = result.conflicts.length ? `${pc.yellow("▲")} Pulled ${result.pulled.length} Specs; ${result.conflicts.length} local conflict${result.conflicts.length === 1 ? "" : "s"}` : success(`Pulled ${result.pulled.length} Spec${result.pulled.length === 1 ? "" : "s"}`);
    return [head, "", ...result.pulled.map((spec) => `  ${pc.green("✔")} ${spec.path}`), ...result.conflicts.map((item) => `  ${pc.yellow("▲")} ${item.path} ${pc.dim("· unpublished edits preserved")}`), result.conflicts.length ? `\n${pc.dim("Save or resolve local edits, then run specbook pull again.")}` : next("specbook run")].join("\n");
}

export function renderPublish(result: Awaited<ReturnType<typeof publish>>) {
    return [success(`Published ${result.specs.length} Spec${result.specs.length === 1 ? "" : "s"}`), "", fields([["Server", result.url], ["Environment", result.environment], ["Commit", result.commitSha]]), "", ...result.specs.map((spec) => `  ${spec.status === "awaiting_deploy" ? pc.yellow("◷") : pc.green("✔")} ${spec.path} ${pc.dim(`· ${spec.status === "awaiting_deploy" ? "waiting for deploy" : spec.status}`)}`), `\n${pc.dim("A passing server run makes each waiting Spec a regular acceptance check.")}`].join("\n");
}

export function renderCi(result: CiResult) {
    const passed = result.results.filter((item) => item.status === "passed").length;
    return [
        `${badge(result.qualityGate.passed ? "passed" : "failed")} ${passed} of ${result.results.length} Specs passed ${pc.dim(`· ${duration(result.durationMs)}${result.environment ? ` · ${result.environment}` : ""}`)}`, "",
        ...result.results.map((item) => {
            const waiting = item.awaitingDeploy && item.status !== "passed";
            const label = waiting ? "waiting for deploy" : item.flaky ? "flaky" : item.knownBug && item.status !== "passed" ? "known bug" : item.status;
            const line = `  ${waiting ? pc.yellow("◷") : icon(item.status)} ${item.title} ${pc.dim(`· ${label}`)}`;
            return item.failsGate ? `${line}\n${indent(pc.red(briefReason(item.failReason)), 6)}` : line;
        }), "",
        fields([["Failures", String(result.qualityGate.failures)], ["Waiting", String(result.qualityGate.awaitingDeploy)], ["Report", relative(result.report)], ["JUnit", relative(result.junit)], ["Summary", relative(result.summary)], ["Run", result.url]]),
    ].join("\n");
}
