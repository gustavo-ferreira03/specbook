import type { Job } from "../../infra/repositories/jobs";

export const ACTIVE_JOB_STATUSES: readonly Job["status"][] = ["queued", "running", "blocked", "paused", "stalled"];

export const oldestFirst = (a: { createdAt: string; id: string }, b: { createdAt: string; id: string }) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

export const finishedAt = (run: { startedAt: string; durationMs: number | null }) => new Date(Date.parse(run.startedAt) + (run.durationMs ?? 0)).toISOString();
