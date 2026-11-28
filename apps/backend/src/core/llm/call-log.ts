import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { withFileQueue } from "../operations/file-queue";
import { storageRoot } from "../paths";

// Model calls made outside a chat turn (evidence review, connection test) are recorded here.
// Chat turns keep their own record in chat-turns.jsonl.
export const modelCallsPath = path.join(
  storageRoot,
  "metrics",
  "model-calls.jsonl"
);

export type ModelCallPurpose = "evidence_review" | "connection_test";
// "cached" and "skipped" made no provider request, so their usage stays null instead of zero.
export type ModelCallOutcome =
  | "completed"
  | "cached"
  | "skipped"
  | "provider_error"
  | "invalid_response"
  | "failed";

export interface ReportedUsage {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  reasoning: number | null;
  totalTokens: number | null;
  cost: {
    input: number | null;
    output: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
    total: number | null;
  } | null;
}

export interface ModelDescription {
  provider: string;
  id: string;
  api: string | null;
  baseUrl: string | null;
  reasoning: boolean | null;
  contextWindow: number | null;
  maxTokens: number | null;
  // Rates from the model catalog, used by the library to compute usage.cost. They are a price table, not a bill.
  costRates: unknown;
}

export interface ModelCallRecord {
  schemaVersion: 1;
  callId: string;
  purpose: ModelCallPurpose;
  startedAt: string;
  durationMs: number;
  outcome: ModelCallOutcome;
  reason: string | null;
  model: ModelDescription | null;
  request: Record<string, unknown> | null;
  payload: PayloadSummary | null;
  stopReason: string | null;
  usage: ReportedUsage | null;
  context: Record<string, unknown>;
}

export interface PayloadSummary {
  keys: string[];
  parameters: Record<string, unknown>;
  messageCount: number | null;
  toolCount: number | null;
  imageCount: number;
}

const reported = function reported(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

// Keeps "not reported" apart from zero: a missing field stays null.
export const reportedUsage = function reportedUsage(
  usage: unknown
): ReportedUsage | null {
  if (!usage || typeof usage !== "object") {
    return null;
  }
  const value = usage as Record<string, unknown>;
  const cost =
    value.cost && typeof value.cost === "object"
      ? (value.cost as Record<string, unknown>)
      : null;
  return {
    input: reported(value.input),
    output: reported(value.output),
    cacheRead: reported(value.cacheRead),
    cacheWrite: reported(value.cacheWrite),
    reasoning: reported(value.reasoning),
    totalTokens: reported(value.totalTokens),
    cost: cost
      ? {
          input: reported(cost.input),
          output: reported(cost.output),
          cacheRead: reported(cost.cacheRead),
          cacheWrite: reported(cost.cacheWrite),
          total: reported(cost.total),
        }
      : null,
  };
};

export const describeModel = function describeModel(
  model: unknown
): ModelDescription | null {
  if (!model || typeof model !== "object") {
    return null;
  }
  const value = model as Record<string, unknown>;
  if (typeof value.provider !== "string" || typeof value.id !== "string") {
    return null;
  }
  return {
    provider: value.provider,
    id: value.id,
    api: typeof value.api === "string" ? value.api : null,
    baseUrl: typeof value.baseUrl === "string" ? value.baseUrl : null,
    reasoning: typeof value.reasoning === "boolean" ? value.reasoning : null,
    contextWindow: reported(value.contextWindow),
    maxTokens: reported(value.maxTokens),
    costRates: value.cost ?? null,
  };
};

// Conversation content, prompts, tool schemas and identifiers stay out of the log.
const CONTENT_KEYS = new Set([
  "messages",
  "input",
  "system",
  "instructions",
  "tools",
  "contents",
  "systemInstruction",
  "prompt",
  "metadata",
  "user",
  "prompt_cache_key",
  "previous_response_id",
  "safety_identifier",
]);

const countImages = function countImages(value: unknown, depth = 0): number {
  if (depth > 6 || !value || typeof value !== "object") {
    return 0;
  }
  if (Array.isArray(value)) {
    return value.reduce<number>(
      (total, item) => total + countImages(item, depth + 1),
      0
    );
  }
  const record = value as Record<string, unknown>;
  const own =
    typeof record.type === "string" && /image/u.test(record.type) ? 1 : 0;
  return (
    own +
    Object.values(record).reduce<number>(
      (total, item) => total + countImages(item, depth + 1),
      0
    )
  );
};

// The array that holds the conversation, whichever key the provider adapter uses for it.
const conversationOf = function conversationOf(
  record: Record<string, unknown>
): unknown[] | null {
  if (Array.isArray(record.messages)) {
    return record.messages;
  }
  if (Array.isArray(record.input)) {
    return record.input;
  }
  if (Array.isArray(record.contents)) {
    return record.contents;
  }
  return null;
};

// The request body as the provider adapter built it, reduced to its generation parameters.
export const summarizePayload = function summarizePayload(
  payload: unknown
): PayloadSummary | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const parameters: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (CONTENT_KEYS.has(key)) {
      continue;
    }
    if (
      value === null ||
      ["string", "number", "boolean"].includes(typeof value)
    ) {
      parameters[key] = value;
    } else if (
      typeof value === "object" &&
      JSON.stringify(value).length <= 400
    ) {
      parameters[key] = value;
    }
  }
  const conversation = conversationOf(record);
  return {
    keys: Object.keys(record).toSorted(),
    parameters,
    messageCount: conversation ? conversation.length : null,
    toolCount: Array.isArray(record.tools) ? record.tools.length : null,
    imageCount: countImages(conversation),
  };
};

export const appendMetricsRecord = async function appendMetricsRecord(
  filePath: string,
  record: unknown
): Promise<void> {
  try {
    await withFileQueue(filePath, async () => {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, "utf-8");
    });
  } catch (error) {
    console.error(`Failed to write ${path.basename(filePath)}:`, error);
  }
};

export class ModelCallRecorder {
  private readonly started = Date.now();
  private payload: PayloadSummary | null = null;
  private model: ModelDescription | null = null;
  private request: Record<string, unknown> | null = null;
  private written = false;

  private readonly purpose: ModelCallPurpose;

  private readonly context: Record<string, unknown>;

  constructor(
    purpose: ModelCallPurpose,
    context: Record<string, unknown> = {}
  ) {
    this.purpose = purpose;
    this.context = context;
  }

  readonly onPayload = (payload: unknown): undefined => {
    this.payload = summarizePayload(payload);
  };

  sending(model: unknown, request: Record<string, unknown>): void {
    this.model = describeModel(model);
    this.request = request;
  }

  async finish(
    outcome: ModelCallOutcome,
    details: {
      reason?: string | null;
      stopReason?: string | null;
      usage?: unknown;
      context?: Record<string, unknown>;
    } = {}
  ): Promise<void> {
    if (this.written) {
      return;
    }
    this.written = true;
    const record: ModelCallRecord = {
      schemaVersion: 1,
      callId: crypto.randomUUID(),
      purpose: this.purpose,
      startedAt: new Date(this.started).toISOString(),
      durationMs: Date.now() - this.started,
      outcome,
      reason: details.reason ?? null,
      model: this.model,
      request: this.request,
      payload: this.payload,
      stopReason: details.stopReason ?? null,
      usage:
        outcome === "cached" || outcome === "skipped"
          ? null
          : reportedUsage(details.usage),
      context: { ...this.context, ...details.context },
    };
    await appendMetricsRecord(modelCallsPath, record);
  }
}
