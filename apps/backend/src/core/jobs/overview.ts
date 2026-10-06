import type { RunEnvironment } from "../../infra/db/schema";
import { jobsRepository } from "../../infra/repositories/jobs";
import { runsRepository, type Run } from "../../infra/repositories/runs";
import { schedulesRepository } from "../../infra/repositories/schedules";
import { specsRepository } from "../../infra/repositories/specs";
import { stewardRepository } from "../../infra/repositories/steward";
import { createProjectScrubber } from "../credentials/scrub";
import { listRunBatches, type RunBatchTrigger } from "../runner/batch";
import { runTriggerForIntent } from "../steward/signals";
import { projectPresentation, type ActivityStory, type PresentedItem } from "./presentation";
import { sanitizeTechnicalDetails } from "./presentation-errors";
import { matchesCurrentSpec } from "./current-run";

export type SpecHealthStatus = "draft" | "passing" | "failing" | "flaky" | "not_checked" | "running" | "invalid";
export interface SpecHealth {
    status: SpecHealthStatus;
    label: string;
    runId?: string;
    lastCheckedAt: string | null;
}
export interface RecentRun extends ActivityStory {
    trigger: RunBatchTrigger;
    environment?: RunEnvironment;
    occurrences: number;
    counts: { total: number; passed: number; failed: number; flaky: number; running: number };
}

const oldestFirst = (a: { createdAt: string; id: string }, b: { createdAt: string; id: string }) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
const newestFirst = (a: { updatedAt: string; id: string }, b: { updatedAt: string; id: string }) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
const pending = (item: PresentedItem) => ["pending", "applying"].includes(item.status);
const finishedAt = (run: Run) => new Date(Date.parse(run.startedAt) + (run.durationMs ?? 0)).toISOString();
const countLabel = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

export async function projectOverview(projectId: string) {
    const [view, jobs, specs, intents, settings, schedule, batches, signals] = await Promise.all([
        projectPresentation(projectId), jobsRepository.list(projectId), specsRepository.listSpecs(projectId),
        stewardRepository.intents(projectId), stewardRepository.get(projectId), schedulesRepository.get(projectId), listRunBatches(projectId), stewardRepository.signals(projectId),
    ]);
    const scrub = createProjectScrubber(projectId);
    const clean = async (text: string) => sanitizeTechnicalDetails(await scrub(text));
    const runLists = new Map(await Promise.all(specs.map(async (spec) => [spec.id, await runsRepository.listRuns(spec.id, { limit: 20 })] as const)));
    const allRuns = new Map([...runLists.values()].flat().map((run) => [run.id, run]));
    const currentRuns = new Map(await Promise.all(specs.map(async (spec) => {
        const latest = runLists.get(spec.id)?.[0];
        return [spec.id, latest && await matchesCurrentSpec(latest, spec) ? latest : undefined] as const;
    })));
    const specHealth: Record<string, SpecHealth> = {};
    const healthCounts: Record<SpecHealthStatus | "total", number> = { total: specs.length, draft: 0, passing: 0, failing: 0, flaky: 0, not_checked: 0, running: 0, invalid: 0 };
    for (const spec of specs) {
        const current = currentRuns.get(spec.id);
        const status: SpecHealthStatus = spec.lifecycle === "draft" ? "draft" : spec.status === "invalid" ? "invalid"
            : current?.status === "running" ? "running" : !current ? "not_checked"
            : current.flaky ? "flaky" : current.status === "passed" ? "passing" : "failing";
        const label = status === "draft" ? `Draft${current ? ` · first run ${current.status}` : " · not run yet"}` : status === "invalid" ? "Needs repair"
            : status === "running" ? "Running"
            : status === "not_checked" ? "Not run since the last change" : status === "flaky" ? "Passed on retry"
            : status === "passing" ? "Passing" : "Latest run failed";
        specHealth[spec.id] = { status, label, runId: current?.id, lastCheckedAt: current && current.status !== "running" ? finishedAt(current) : null };
        healthCounts[status]++;
    }

    const failingIds = new Set(specs.filter((spec) => specHealth[spec.id]?.status === "failing").map((spec) => spec.id));
    const runFamilies = new Map(specs.map((spec) => {
        const latest = currentRuns.get(spec.id);
        return [spec.id, new Set(latest ? [latest.id, ...(latest.retryOf ? [latest.retryOf] : []),
            ...(runLists.get(spec.id) ?? []).filter((run) => run.retryOf === latest.id).map((run) => run.id)] : [])] as const;
    }));
    const currentFinding = (item: PresentedItem) => {
        const job = jobs.find((job) => job.id === item.jobId);
        const spec = specs.find((spec) => spec.id === item.presentation.specId);
        const runId = typeof item.payload.runId === "string" ? item.payload.runId : job?.runId;
        return Boolean(runId && runFamilies.get(spec?.id ?? "")?.has(runId))
            || Boolean(spec?.status === "invalid" && job?.kind === "regenerate" && job.specId === spec.id && !runId);
    };
    const needsYou = view.items.filter((item) => pending(item) && (item.kind !== "bug_report" || !failingIds.has(item.presentation.specId ?? "") || !currentFinding(item)))
        .map((item) => item.kind === "bug_report" ? { ...item, presentation: { ...item.presentation, title: `Add a regression Spec for “${specs.find((spec) => spec.id === item.presentation.specId)?.title ?? item.presentation.title}”?` } } : item).sort(oldestFirst);
    const agentPaused = view.summary.paused || view.summary.globallyPaused;
    const failing = specs.filter((spec) => failingIds.has(spec.id)).map((spec) => {
        const related = view.items.filter((item) => item.presentation.specId === spec.id
            && (item.presentation.type === "update" || currentFinding(item)));
        const decisions = related.filter(pending);
        const job = jobs.find((job) => job.specId === spec.id && (job.runId ? runFamilies.get(spec.id)?.has(job.runId) : spec.status === "invalid" && job.kind === "regenerate"));
        const story = view.activity.find((story) => story.specId === spec.id
            && (job && story.jobIds.includes(job.id) || decisions.some((item) => story.inboxIds.includes(item.id))));
        const triageStatus = decisions.some((item) => item.presentation.type === "update") ? "Fix waiting for you"
            : decisions.some((item) => ["question", "help"].includes(item.presentation.type)) ? "Needs your answer"
            : decisions.some((item) => item.kind === "bug_report") || job?.classification === "application_bug" ? "App bug reported"
            : agentPaused ? "Paused by you" : job?.status === "running" ? "Investigating…"
            : job?.status === "queued" || (job?.status === "stalled" && job.retryAt) ? "Waiting to investigate"
            : "Latest run failed";
        return { specId: spec.id, title: spec.title, triageStatus, runId: specHealth[spec.id]?.runId,
            updatedAt: specHealth[spec.id]!.lastCheckedAt ?? currentRuns.get(spec.id)!.startedAt, storyId: story?.id,
            inboxIds: (decisions.length ? decisions : related.filter((item) => item.kind === "bug_report")).map((item) => item.id) };
    }).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.specId.localeCompare(b.specId));
    const recentRuns: RecentRun[] = [];
    const batchRunIds = new Set<string>();
    for (const batch of batches) {
        batch.specs.forEach((entry) => batchRunIds.add(entry.runId));
        const results = await Promise.all(batch.specs.map(async (entry) => {
            const run = allRuns.get(entry.runId) ?? await runsRepository.getRun(entry.runId);
            const retry = run && (run.automationPending || run.flaky || ["failed", "error"].includes(run.status)) ? await runsRepository.retryFor(run.id) : null;
            return { entry, run, retry };
        }));
        const running = batch.status === "running" || results.some(({ run }) => run?.automationPending);
        const outcomes = results.map(({ entry, run }) => (run?.status ?? entry.status) === "running" || run?.automationPending ? "running"
            : run?.flaky ? "flaky" : (run?.status ?? entry.status) === "passed" ? "passed" : "failed");
        const passed = outcomes.filter((outcome) => outcome === "passed").length;
        const flaky = outcomes.filter((outcome) => outcome === "flaky").length;
        const runningCount = outcomes.filter((outcome) => outcome === "running").length;
        const failed = outcomes.filter((outcome) => outcome === "failed").length;
        const intent = intents.find((intent) => intent.batchId === batch.id);
        const trigger = batch.trigger ?? (batch.ci ? "ci" : batch.label === "Scheduled run" ? "schedule" : runTriggerForIntent(intent, intents, signals));
        const prefix = trigger === "deploy" ? "After the deployment" : trigger === "ci" ? "CI run" : trigger === "schedule" ? "Scheduled run" : trigger === "spec_change" ? "After Spec changes" : "Run";
        const result = failed === 0 && flaky === 0 ? "all passed" : [passed ? `${passed} passed` : "", flaky ? `${flaky} passed on retry` : "", failed ? `${failed} failed` : ""].filter(Boolean).join(", ");
        const title = running ? `${prefix}: running ${countLabel(batch.specs.length, "Spec")}` : `${prefix}: ${countLabel(batch.specs.length, "Spec")} ran, ${result}`;
        const updatedAt = [new Date(Date.parse(batch.startedAt) + (batch.durationMs ?? 0)).toISOString(),
            ...results.flatMap(({ run, retry }) => run ? [finishedAt(retry ?? run)] : [])].sort().at(-1)!;
        const details = results.map(({ entry, run }) => `${entry.title}: ${run?.flaky ? "passed on retry" : run?.status ?? entry.status}${run?.failReason ? `\n${run.failReason}` : ""}`).join("\n\n");
        const story: RecentRun = {
            environment: batch.environment, id: `batch:${batch.id}`, subject: { type: trigger === "deploy" ? "deployment" : "project", id: batch.id, name: batch.label }, trigger, occurrences: 1,
            counts: { total: results.length, passed, failed, flaky, running: runningCount },
            title, summary: "", status: running ? "working" : "completed", outcome: running ? undefined : failed ? "failed" : flaky ? "flaky" : "passed", nextStep: running ? "Results will appear here when the Specs finish." : failed ? "Open a failed Spec to inspect its evidence." : "",
            createdAt: batch.startedAt, updatedAt, timeline: results.map(({ entry, run, retry }) => ({ id: entry.runId, label: entry.title, specId: entry.specId, runId: retry?.id ?? entry.runId,
                detail: run?.flaky ? "Passed on retry." : run?.automationPending ? retry?.status === "running" ? "Running again after a failure." : "Waiting for the failure retry." : `${run?.status ?? entry.status}.`,
                createdAt: run ? finishedAt(retry ?? run) : updatedAt })).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
            jobIds: [], inboxIds: [], technicalDetails: await clean(details),
        };
        recentRuns.push(story);
    }

    const repeatedRuns = new Map<string, RecentRun>();
    for (const spec of specs) for (const run of runLists.get(spec.id) ?? []) {
        if (run.retryOf || batchRunIds.has(run.id)) continue;
        const running = run.status === "running" || run.automationPending;
        const retry = run.automationPending || run.flaky || ["failed", "error"].includes(run.status) ? await runsRepository.retryFor(run.id) : null;
        const story: RecentRun = {
            environment: run.environment ?? undefined, id: `run:${run.id}`, subject: { type: "spec", id: spec.id, name: spec.title }, specId: spec.id, runId: retry?.id ?? run.id,
            trigger: "manual", occurrences: 1, counts: { total: 1, passed: !running && !run.flaky && run.status === "passed" ? 1 : 0, failed: !running && !run.flaky && run.status !== "passed" ? 1 : 0, flaky: !running && run.flaky ? 1 : 0, running: running ? 1 : 0 },
            title: running ? `Checking “${spec.title}”${run.status === "running" ? "" : " again after a failure"}`
                : `“${spec.title}” ${run.flaky ? "passed on retry" : run.status === "passed" ? "passed" : "failed its test run"}`,
            summary: "", status: running ? "working" : "completed", outcome: running ? undefined : run.flaky ? "flaky" : run.status === "passed" ? "passed" : "failed", nextStep: running ? "The result will appear here when the run finishes." : run.status === "passed" || run.flaky ? "" : "Open the Spec to inspect its evidence.",
            createdAt: run.startedAt, updatedAt: finishedAt(retry ?? run), timeline: [{ id: `run:${run.id}`, label: spec.title, detail: run.flaky ? "Passed on retry." : `${run.status}.`, createdAt: finishedAt(retry ?? run), specId: spec.id, runId: retry?.id ?? run.id }], jobIds: [], inboxIds: [], technicalDetails: await clean(run.failReason ?? ""),
        };
        const key = JSON.stringify([spec.id, run.sourceHash, run.commitSha, run.baseUrl, story.outcome, run.failReason, run.startedAt.slice(0, 10)]);
        const repeated = !running && repeatedRuns.get(key);
        if (repeated) {
            repeated.occurrences++;
            for (const outcome of ["total", "passed", "failed", "flaky", "running"] as const) repeated.counts[outcome] += story.counts[outcome];
            repeated.timeline.push(...story.timeline);
            repeated.timeline.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
            repeated.createdAt = [repeated.createdAt, story.createdAt].sort()[0]!;
            repeated.updatedAt = [repeated.updatedAt, story.updatedAt].sort().at(-1)!;
            repeated.title = `“${spec.title}” ${run.flaky ? "passed on retry" : run.status === "passed" ? "passed" : "failed"} in ${countLabel(repeated.occurrences, "run")}`;
            continue;
        }
        if (!running) repeatedRuns.set(key, story);
        recentRuns.push(story);
    }
    recentRuns.sort(newestFirst);
    const lastCheckedAt = Object.values(specHealth).flatMap((health) => health.lastCheckedAt ? [health.lastCheckedAt] : []).sort().at(-1) ?? null;
    const verdict = [specs.length ? `${healthCounts.passing} of ${specs.length - healthCounts.draft} active Specs passing` : "No Specs yet",
        healthCounts.failing ? `${healthCounts.failing} failing` : "", healthCounts.flaky ? `${healthCounts.flaky} flaky` : "",
        healthCounts.invalid ? `${healthCounts.invalid} need repairing` : "",
        healthCounts.draft ? `${healthCounts.draft} drafts` : "",
        healthCounts.not_checked ? `${healthCounts.not_checked} not run yet` : "", healthCounts.running ? `${healthCounts.running} running` : ""].filter(Boolean).join(" · ");
    const activeCount = recentRuns.filter((run) => run.status === "working").length + jobs.filter((job) => job.status === "running").length;
    const nextCheckAt = agentPaused ? null : schedule?.nextRunAt ?? null;
    const nextCheck = agentPaused ? "Resume Specbook to continue."
        : activeCount ? `${countLabel(activeCount, "Spec")} in progress.`
        : healthCounts.invalid === specs.length && specs.length > 0 ? "Repair the incomplete Specs in chat before running them."
        : settings.autonomy === "observe" ? "Observation mode records changes. Request a coverage review or explore the app when needed."
        : nextCheckAt ? ""
        : "Waiting for a deployment, a Spec change or your request.";
    return { summary: { projectName: view.summary.projectName, statusText: view.summary.statusText, paused: view.summary.paused, globallyPaused: view.summary.globallyPaused,
        autonomy: settings.autonomy, systemHealth: view.summary.systemHealth, verdict, nextCheck, nextCheckAt, attentionCount: needsYou.length, activeCount, lastCheckedAt, specHealth: healthCounts },
        specHealth, needsYou, failing, recentRuns: recentRuns.slice(0, 100), items: view.items.map((item) => needsYou.find((decision) => decision.id === item.id) ?? item), stories: view.activity };
}
