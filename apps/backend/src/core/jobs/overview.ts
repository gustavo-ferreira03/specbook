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

export type SpecHealthStatus = "passing" | "failing" | "flaky" | "not_checked" | "running";
export interface SpecHealth {
    status: SpecHealthStatus;
    label: string;
    runId?: string;
    lastCheckedAt: string | null;
}
export interface RecentRun extends ActivityStory {
    trigger: RunBatchTrigger;
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
    const specHealth: Record<string, SpecHealth> = {};
    const healthCounts: Record<SpecHealthStatus | "total", number> = { total: specs.length, passing: 0, failing: 0, flaky: 0, not_checked: 0, running: 0 };
    for (const spec of specs) {
        const latest = runLists.get(spec.id)?.[0];
        const current = latest?.sourceHash === spec.sourceHash ? latest : undefined;
        const status: SpecHealthStatus = current?.status === "running" ? "running"
            : spec.status === "invalid" ? "failing"
            : !current || spec.status === "unverified" ? "not_checked"
            : current.flaky ? "flaky" : current.status === "passed" ? "passing" : "failing";
        const label = status === "running" ? "Check running"
            : status === "not_checked" ? "Current version not checked yet" : status === "flaky" ? "Passed on retry"
            : status === "passing" ? "Passing" : spec.status === "invalid" ? "Check needs an update" : "Latest check failed";
        specHealth[spec.id] = { status, label, runId: current?.id, lastCheckedAt: latest && latest.status !== "running" ? finishedAt(latest) : null };
        healthCounts[status]++;
    }

    const failingIds = new Set(specs.filter((spec) => specHealth[spec.id]?.status === "failing").map((spec) => spec.id));
    const runFamilies = new Map(specs.map((spec) => {
        const candidate = runLists.get(spec.id)?.[0];
        const latest = spec.status !== "invalid" && candidate?.sourceHash === spec.sourceHash ? candidate : undefined;
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
        .map((item) => item.kind === "bug_report" ? { ...item, presentation: { ...item.presentation, title: `Add a regression check for “${item.presentation.title}”?` } } : item).sort(oldestFirst);
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
            : spec.status === "invalid" ? "Check needs an update" : "Latest check failed";
        return { specId: spec.id, title: spec.title, triageStatus, runId: specHealth[spec.id]?.runId,
            updatedAt: job?.updatedAt ?? spec.updatedAt, storyId: story?.id,
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
        const prefix = trigger === "deploy" ? "After the deployment" : trigger === "ci" ? "CI check" : trigger === "schedule" ? "Scheduled check" : trigger === "spec_change" ? "After check changes" : "Check run";
        const result = failed === 0 && flaky === 0 ? "all passed" : [passed ? `${passed} passed` : "", flaky ? `${flaky} passed on retry` : "", failed ? `${failed} failed` : ""].filter(Boolean).join(", ");
        const title = running ? `${prefix}: running ${countLabel(batch.specs.length, "check")}` : `${prefix}: ${countLabel(batch.specs.length, "check")} ran, ${result}`;
        const updatedAt = [new Date(Date.parse(batch.startedAt) + (batch.durationMs ?? 0)).toISOString(),
            ...results.flatMap(({ run, retry }) => run ? [finishedAt(retry ?? run)] : [])].sort().at(-1)!;
        const details = results.map(({ entry, run }) => `${entry.title}: ${run?.flaky ? "passed on retry" : run?.status ?? entry.status}${run?.failReason ? `\n${run.failReason}` : ""}`).join("\n\n");
        const story: RecentRun = {
            id: `batch:${batch.id}`, subject: { type: trigger === "deploy" ? "deployment" : "project", id: batch.id, name: batch.label }, trigger,
            counts: { total: results.length, passed, failed, flaky, running: runningCount },
            title, summary: "", status: running ? "working" : "completed", outcome: running ? undefined : failed ? "failed" : flaky ? "flaky" : "passed", nextStep: running ? "Results will appear here when the checks finish." : failed ? "Open a failed check to inspect its evidence." : "",
            createdAt: batch.startedAt, updatedAt, timeline: results.map(({ entry, run, retry }) => ({ id: entry.runId, label: entry.title, specId: entry.specId, runId: retry?.id ?? entry.runId,
                detail: run?.flaky ? "Passed on retry." : run?.automationPending ? retry?.status === "running" ? "Running again after a failure." : "Waiting for the failure retry." : `${run?.status ?? entry.status}.`,
                createdAt: run ? finishedAt(retry ?? run) : updatedAt })).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
            jobIds: [], inboxIds: [], technicalDetails: await clean(details),
        };
        recentRuns.push(story);
    }

    for (const spec of specs) for (const run of runLists.get(spec.id) ?? []) {
        if (run.retryOf || batchRunIds.has(run.id)) continue;
        const running = run.status === "running" || run.automationPending;
        const retry = run.automationPending || run.flaky || ["failed", "error"].includes(run.status) ? await runsRepository.retryFor(run.id) : null;
        const story: RecentRun = {
            id: `run:${run.id}`, subject: { type: "spec", id: spec.id, name: spec.title }, specId: spec.id, runId: retry?.id ?? run.id,
            trigger: "manual", counts: { total: 1, passed: !running && !run.flaky && run.status === "passed" ? 1 : 0, failed: !running && !run.flaky && run.status !== "passed" ? 1 : 0, flaky: !running && run.flaky ? 1 : 0, running: running ? 1 : 0 },
            title: running ? `Checking “${spec.title}”${run.status === "running" ? "" : " again after a failure"}`
                : `“${spec.title}” ${run.flaky ? "passed on retry" : run.status === "passed" ? "passed" : "failed its test run"}`,
            summary: "", status: running ? "working" : "completed", outcome: running ? undefined : run.flaky ? "flaky" : run.status === "passed" ? "passed" : "failed", nextStep: running ? "The result will appear here when the check finishes." : run.status === "passed" || run.flaky ? "" : "Open the check to inspect its evidence.",
            createdAt: run.startedAt, updatedAt: finishedAt(retry ?? run), timeline: [], jobIds: [], inboxIds: [], technicalDetails: await clean(run.failReason ?? ""),
        };
        recentRuns.push(story);
    }
    recentRuns.sort(newestFirst);
    const lastCheckedAt = [...runLists.values()].flat().filter((run) => run.status !== "running").map(finishedAt).sort().at(-1) ?? null;
    const verdict = [specs.length ? `${healthCounts.passing} of ${specs.length} checks passing` : "No checks yet",
        healthCounts.failing ? `${healthCounts.failing} failing` : "", healthCounts.flaky ? `${healthCounts.flaky} flaky` : "",
        healthCounts.not_checked ? `${healthCounts.not_checked} not run yet` : "", healthCounts.running ? `${healthCounts.running} running` : ""].filter(Boolean).join(" · ");
    const activeCount = recentRuns.filter((run) => run.status === "working").length + jobs.filter((job) => job.status === "running").length;
    const nextCheckAt = agentPaused ? null : schedule?.nextRunAt ?? null;
    const nextCheck = agentPaused ? "Resume Specbook to continue."
        : activeCount ? `${countLabel(activeCount, "check")} in progress.`
        : settings.autonomy === "observe" ? "Observation mode records changes. You can request an investigation from Actions or chat."
        : nextCheckAt ? "Next scheduled check"
        : "Waiting for a deployment, check change or your request.";
    return { summary: { projectName: view.summary.projectName, statusText: view.summary.statusText, paused: view.summary.paused, globallyPaused: view.summary.globallyPaused,
        autonomy: settings.autonomy, systemHealth: view.summary.systemHealth, verdict, nextCheck, nextCheckAt, attentionCount: needsYou.length, activeCount, lastCheckedAt, specHealth: healthCounts },
        specHealth, needsYou, failing, recentRuns: recentRuns.slice(0, 100), items: view.items.map((item) => needsYou.find((decision) => decision.id === item.id) ?? item), stories: view.activity };
}
