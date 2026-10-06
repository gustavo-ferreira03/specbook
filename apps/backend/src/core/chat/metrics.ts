import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { storageRoot } from "../paths";

// Per-turn evaluation metrics, appended as JSONL to <storageRoot>/metrics/chat-turns.jsonl.
// Records hold identifiers, counters, timings and token usage only: never message
// content, tool arguments, failure messages or credential values.

export const metricsDir = path.join(storageRoot, "metrics");
export const chatTurnMetricsPath = path.join(metricsDir, "chat-turns.jsonl");

export type TurnTrigger = "message" | "edit" | "retry";
export type TurnOutcome = "completed" | "aborted" | "error" | "rejected";

export interface RunSpecOutcome {
    specId: string;
    runId: string | null;
    status: string;
    durationMs: number | null;
    /** 1-based index of this run_spec call among all run_spec calls in the chat. */
    chatAttempt: number;
    /** 1-based index of this run_spec call for the same Spec in the chat. */
    specAttempt: number;
}

export interface ValidatorRejection {
    tool: "create_spec" | "update_spec";
    specId: string | null;
    /** named_steps: step() titles differ from humanSpec.steps; source_validation: the spec.ts allowlist check failed. */
    rule: "named_steps" | "source_validation";
}

export interface ChatTurnMetrics {
    schemaVersion: 1;
    turnId: string;
    chatId: string;
    projectId: string | null;
    mode: "standard" | "discovery" | null;
    trigger: TurnTrigger;
    provider: string | null;
    model: string | null;
    startedAt: string;
    endedAt: string | null;
    durationMs: number | null;
    outcome: TurnOutcome;
    /** Machine-readable reason for error/rejected outcomes, never a free-form message. */
    errorKind: string | null;
    browserAvailable: boolean;
    /** User messages sent to the model this turn (the prompt plus follow-ups/steering). */
    userMessages: number;
    autoRetries: number;
    assistantMessages: number;
    toolCallCount: number;
    toolCalls: Record<string, number>;
    toolErrorCount: number;
    toolErrors: Record<string, number>;
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; total: number };
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
    runSpec: RunSpecOutcome[];
    validatorRejections: ValidatorRejection[];
}

interface UsageLike {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    reasoning?: number;
    totalTokens?: number;
    cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
}

function num(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function increment(counter: Record<string, number>, key: string): void {
    counter[key] = (counter[key] ?? 0) + 1;
}

/** Counts run_spec calls already present in the chat's session, across all branches. */
function previousRunSpecCalls(sessionManager: SessionManager | null): { total: number; bySpec: Map<string, number> } {
    const bySpec = new Map<string, number>();
    let total = 0;
    if (!sessionManager) return { total, bySpec };
    for (const entry of sessionManager.getEntries()) {
        if (entry.type !== "message" || entry.message.role !== "assistant") continue;
        const content = (entry.message as { content?: unknown }).content;
        if (!Array.isArray(content)) continue;
        for (const part of content) {
            const call = part as { type?: string; name?: string; arguments?: { specId?: unknown } };
            if (call?.type !== "toolCall" || call.name !== "run_spec") continue;
            total += 1;
            const specId = typeof call.arguments?.specId === "string" ? call.arguments.specId : "";
            bySpec.set(specId, (bySpec.get(specId) ?? 0) + 1);
        }
    }
    return { total, bySpec };
}

export class TurnMetricsRecorder {
    readonly record: ChatTurnMetrics;
    private readonly started = Date.now();
    private runSpecTotal = 0;
    private runSpecBySpec = new Map<string, number>();
    private finished = false;

    constructor(chatId: string, trigger: TurnTrigger) {
        this.record = {
            schemaVersion: 1,
            turnId: crypto.randomUUID(),
            chatId,
            projectId: null,
            mode: null,
            trigger,
            provider: null,
            model: null,
            startedAt: new Date(this.started).toISOString(),
            endedAt: null,
            durationMs: null,
            outcome: "completed",
            errorKind: null,
            browserAvailable: false,
            userMessages: 0,
            autoRetries: 0,
            assistantMessages: 0,
            toolCallCount: 0,
            toolCalls: {},
            toolErrorCount: 0,
            toolErrors: {},
            tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 },
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            runSpec: [],
            validatorRejections: [],
        };
    }

    /** Seeds run_spec attempt counters from the run_spec calls already in the session. */
    seedFromSession(sessionManager: SessionManager | null): void {
        try {
            const previous = previousRunSpecCalls(sessionManager);
            this.runSpecTotal = previous.total;
            this.runSpecBySpec = previous.bySpec;
        } catch {}
    }

    fail(outcome: Exclude<TurnOutcome, "completed">, errorKind: string | null = null): void {
        // Keep the first failure; later ones are usually consequences of it.
        if (this.record.outcome !== "completed") return;
        this.record.outcome = outcome;
        this.record.errorKind = errorKind;
    }

    toolStart(toolName: string): void {
        this.record.toolCallCount += 1;
        increment(this.record.toolCalls, toolName);
    }

    toolEnd(toolName: string, isError: boolean): void {
        if (!isError) return;
        this.record.toolErrorCount += 1;
        increment(this.record.toolErrors, toolName);
    }

    userMessage(): void {
        this.record.userMessages += 1;
    }

    autoRetry(): void {
        this.record.autoRetries += 1;
    }

    setBrowserAvailable(available: boolean): void {
        this.record.browserAvailable = available;
    }

    setContext(context: Partial<Pick<ChatTurnMetrics, "projectId" | "mode" | "provider" | "model">>): void {
        Object.assign(this.record, context);
    }

    assistantMessage(message: { usage?: UsageLike; provider?: string; model?: string }): void {
        this.record.assistantMessages += 1;
        const usage = message.usage;
        if (!usage) return;
        const { tokens, cost } = this.record;
        tokens.input += num(usage.input);
        tokens.output += num(usage.output);
        tokens.cacheRead += num(usage.cacheRead);
        tokens.cacheWrite += num(usage.cacheWrite);
        tokens.reasoning += num(usage.reasoning);
        tokens.total += num(usage.totalTokens);
        cost.input += num(usage.cost?.input);
        cost.output += num(usage.cost?.output);
        cost.cacheRead += num(usage.cost?.cacheRead);
        cost.cacheWrite += num(usage.cost?.cacheWrite);
        cost.total += num(usage.cost?.total);
    }

    runSpecOutcome(outcome: { specId: string; runId: string | null; status: string; durationMs: number | null }): void {
        this.runSpecTotal += 1;
        const specAttempt = (this.runSpecBySpec.get(outcome.specId) ?? 0) + 1;
        this.runSpecBySpec.set(outcome.specId, specAttempt);
        this.record.runSpec.push({ ...outcome, chatAttempt: this.runSpecTotal, specAttempt });
    }

    validatorRejection(rejection: ValidatorRejection): void {
        this.record.validatorRejections.push(rejection);
    }

    /** Appends the record once. Never throws: metrics must not break a turn. */
    async finish(): Promise<void> {
        if (this.finished) return;
        this.finished = true;
        try {
            const ended = Date.now();
            this.record.endedAt = new Date(ended).toISOString();
            this.record.durationMs = ended - this.started;
            await appendMetricsLine(JSON.stringify(this.record));
        } catch (error) {
            console.error("Failed to write chat turn metrics:", error);
        }
    }
}

let writeQueue: Promise<void> = Promise.resolve();

function appendMetricsLine(line: string): Promise<void> {
    const write = writeQueue.then(async () => {
        await fs.mkdir(metricsDir, { recursive: true });
        await fs.appendFile(chatTurnMetricsPath, `${line}\n`, "utf8");
    });
    writeQueue = write.catch(() => undefined);
    return write;
}
