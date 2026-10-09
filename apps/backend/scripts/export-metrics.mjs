#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const runsMode = args.includes("--runs");
const agentMode = args.includes("--agent");
const outIndex = args.indexOf("--out");
const outPath = outIndex >= 0 ? args[outIndex + 1] : null;
const positional = args.filter((arg, index) => !arg.startsWith("--") && (outIndex < 0 || index !== outIndex + 1));
const storageRoot = process.env.SPECBOOK_STORAGE_DIR ?? path.join(backendRoot, "storage");
const inputPath = positional[0] ?? path.join(storageRoot, "metrics", agentMode ? "agent-events.jsonl" : "chat-turns.jsonl");

if ((runsMode && agentMode) || (outIndex >= 0 && !outPath)) {
    console.error("Use either --runs or --agent, and supply a file after --out.");
    process.exit(1);
}

if (!fs.existsSync(inputPath)) {
    console.error(`Metrics file not found: ${inputPath}`);
    process.exit(1);
}

const records = [];
fs.readFileSync(inputPath, "utf8")
    .split("\n")
    .forEach((line, index) => {
        if (!line.trim()) return;
        try {
            records.push(JSON.parse(line));
        } catch {
            console.error(`Skipping malformed line ${index + 1}`);
        }
    });

function csvCell(value) {
    if (value === null || value === undefined) return "";
    const text = typeof value === "object" ? JSON.stringify(value) : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function counter(value) {
    return Object.entries(value ?? {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, count]) => `${key}:${count}`)
        .join(";");
}

const turnColumns = [
    ["turnId", (r) => r.turnId],
    ["chatId", (r) => r.chatId],
    ["projectId", (r) => r.projectId],
    ["mode", (r) => r.mode],
    ["trigger", (r) => r.trigger],
    ["provider", (r) => r.provider],
    ["model", (r) => r.model],
    ["startedAt", (r) => r.startedAt],
    ["endedAt", (r) => r.endedAt],
    ["durationMs", (r) => r.durationMs],
    ["outcome", (r) => r.outcome],
    ["errorKind", (r) => r.errorKind],
    ["browserAvailable", (r) => r.browserAvailable],
    ["userMessages", (r) => r.userMessages],
    ["assistantMessages", (r) => r.assistantMessages],
    ["autoRetries", (r) => r.autoRetries],
    ["toolCallCount", (r) => r.toolCallCount],
    ["toolErrorCount", (r) => r.toolErrorCount],
    ["toolCalls", (r) => counter(r.toolCalls)],
    ["toolErrors", (r) => counter(r.toolErrors)],
    ["inputTokens", (r) => r.tokens?.input],
    ["outputTokens", (r) => r.tokens?.output],
    ["cacheReadTokens", (r) => r.tokens?.cacheRead],
    ["cacheWriteTokens", (r) => r.tokens?.cacheWrite],
    ["reasoningTokens", (r) => r.tokens?.reasoning],
    ["totalTokens", (r) => r.tokens?.total],
    ["costTotal", (r) => r.cost?.total],
    ["runSpecCount", (r) => r.runSpec?.length ?? 0],
    ["runSpecPassed", (r) => r.runSpec?.filter((run) => run.status === "passed").length ?? 0],
    ["runSpecFailed", (r) => r.runSpec?.filter((run) => run.status === "failed").length ?? 0],
    ["runSpecError", (r) => r.runSpec?.filter((run) => run.status !== "passed" && run.status !== "failed").length ?? 0],
    ["validatorRejections", (r) => r.validatorRejections?.length ?? 0],
    ["validatorRejectionRules", (r) => counter(
        (r.validatorRejections ?? []).reduce((acc, item) => {
            const key = `${item.tool}/${item.rule}`;
            acc[key] = (acc[key] ?? 0) + 1;
            return acc;
        }, {}),
    )],
];

const runColumns = [
    ["turnId", (r) => r.turn.turnId],
    ["chatId", (r) => r.turn.chatId],
    ["projectId", (r) => r.turn.projectId],
    ["mode", (r) => r.turn.mode],
    ["provider", (r) => r.turn.provider],
    ["model", (r) => r.turn.model],
    ["turnStartedAt", (r) => r.turn.startedAt],
    ["specId", (r) => r.run.specId],
    ["runId", (r) => r.run.runId],
    ["status", (r) => r.run.status],
    ["durationMs", (r) => r.run.durationMs],
    ["chatAttempt", (r) => r.run.chatAttempt],
    ["specAttempt", (r) => r.run.specAttempt],
];

const agentColumns = ["schemaVersion", "eventId", "at", "event", "projectId", "jobId", "chatId", "specId", "runId", "trigger", "kind", "status", "classification", "tokensUsed", "actionsUsed", "elapsedMs", "itemId", "itemKind", "decision", "actor", "verificationStatus"].map((name) => [name, (r) => r[name]]);
const [columns, rows] = agentMode ? [agentColumns, records] : runsMode
    ? [runColumns, records.flatMap((turn) => (turn.runSpec ?? []).map((run) => ({ turn, run })))]
    : [turnColumns, records];

const csv = [
    columns.map(([name]) => name).join(","),
    ...rows.map((row) => columns.map(([, get]) => csvCell(get(row))).join(",")),
].join("\n") + "\n";

if (outPath) fs.writeFileSync(outPath, csv, "utf8");
else process.stdout.write(csv);
