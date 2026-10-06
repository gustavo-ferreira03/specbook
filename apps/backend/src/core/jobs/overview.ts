import { jobsRepository } from "../../infra/repositories/jobs";
import { runsRepository, type Run } from "../../infra/repositories/runs";
import { schedulesRepository } from "../../infra/repositories/schedules";
import { specsRepository } from "../../infra/repositories/specs";
import { stewardRepository } from "../../infra/repositories/steward";
import { createProjectScrubber } from "../credentials/scrub";
import { listRunBatches } from "../runner/batch";
import { projectPresentation, type ActivityStory, type PresentedItem } from "./presentation";
import { isInfrastructureFailure, sanitizeTechnicalDetails } from "./presentation-errors";

export type SpecHealthStatus = "passing" | "failing" | "flaky" | "paused" | "not_checked" | "running";
export interface SpecHealth {
    status: SpecHealthStatus;
    label: string;
    runId?: string;
    lastCheckedAt: string | null;
}
export interface PausedGroup {
    reason: "user";
    label: string;
    count: number;
    stories: ActivityStory[];
    specIds: string[];
}

const oldestFirst = (a: { createdAt: string; id: string }, b: { createdAt: string; id: string }) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
const newestFirst = (a: { updatedAt: string; id: string }, b: { updatedAt: string; id: string }) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
const pending = (item: PresentedItem) => ["pending", "applying"].includes(item.status);
const finishedAt = (run: Run) => new Date(Date.parse(run.startedAt) + (run.durationMs ?? 0)).toISOString();
const countLabel = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

export async function projectOverview(projectId: string) {
    const [view, jobs, specs, intents, settings, schedule, batches] = await Promise.all([
        projectPresentation(projectId), jobsRepository.list(projectId), specsRepository.listSpecs(projectId),
        stewardRepository.intents(projectId), stewardRepository.get(projectId), schedulesRepository.get(projectId), listRunBatches(projectId),
    ]);
    const scrub = createProjectScrubber(projectId);
    const clean = async (text: string) => sanitizeTechnicalDetails(await scrub(text));
    const runLists = new Map(await Promise.all(specs.map(async (spec) => [spec.id, await runsRepository.listRuns(spec.id, { limit: 20 })] as const)));
    const allRuns = new Map([...runLists.values()].flat().map((run) => [run.id, run]));
    const needsYou = view.items.filter((item) => pending(item) && item.kind !== "bug_report").sort(oldestFirst);
    const problems = view.items.filter((item) => pending(item) && item.kind === "bug_report").sort(oldestFirst);
    const paused: PausedGroup[] = [];
    const pause = (stories: ActivityStory[]) => {
        if (!stories.length) return;
        const specIds = [...new Set(stories.flatMap((story) => story.specId ? [story.specId] : []))];
        const count = stories.length;
        const checks = countLabel(count, stories.every((story) => story.specId) ? "check" : "review");
        const label = `${checks} paused by you`;
        paused.push({ reason: "user", label, count, stories: stories.sort(oldestFirst), specIds });
    };
    if (view.summary.paused || view.summary.globallyPaused) pause(view.activity.filter((story) => story.status === "paused" ||
        story.jobIds.some((id) => jobs.some((job) => job.id === id && ["queued", "paused", "stalled"].includes(job.status)))));
    const pausedSpecIds = new Set(paused.flatMap((group) => group.specIds));
    const specHealth: Record<string, SpecHealth> = {};
    const healthCounts: Record<SpecHealthStatus | "total", number> = { total: specs.length, passing: 0, failing: 0, flaky: 0, paused: 0, not_checked: 0, running: 0 };
    for (const spec of specs) {
        const latest = runLists.get(spec.id)?.[0];
        const current = latest?.sourceHash === spec.sourceHash ? latest : undefined;
        const status: SpecHealthStatus = current?.status === "running" ? "running"
            : pausedSpecIds.has(spec.id) ? "paused"
            : spec.status === "invalid" ? "failing"
            : !current || spec.status === "unverified" ? "not_checked"
            : current.flaky ? "flaky" : current.status === "passed" ? "passing" : "failing";
        const label = status === "running" ? "Check running" : status === "paused" ? "Paused by you"
            : status === "not_checked" ? "Current version not checked yet" : status === "flaky" ? "Passed on retry"
            : status === "passing" ? "Passing" : spec.status === "invalid" ? "Check needs an update" : "Latest check failed";
        specHealth[spec.id] = { status, label, runId: current?.id, lastCheckedAt: latest && latest.status !== "running" ? finishedAt(latest) : null };
        healthCounts[status]++;
    }

    const history: ActivityStory[] = [];
    const batchStories: ActivityStory[] = [];
    const batchRunIds = new Set<string>();
    const activeBatchIntents = new Set<string>();
    for (const batch of batches) {
        batch.specs.forEach((entry) => batchRunIds.add(entry.runId));
        const results = await Promise.all(batch.specs.map(async (entry) => {
            const run = allRuns.get(entry.runId) ?? await runsRepository.getRun(entry.runId);
            const retry = run && (run.automationPending || run.flaky || ["failed", "error"].includes(run.status)) ? await runsRepository.retryFor(run.id) : null;
            return { entry, run, retry };
        }));
        const running = batch.status === "running" || results.some(({ run }) => run?.automationPending);
        if (running) for (const intent of intents.filter((intent) => intent.batchId === batch.id)) activeBatchIntents.add(intent.id);
        const passed = results.filter(({ entry, run }) => !run?.flaky && (run?.status ?? entry.status) === "passed").length;
        const flaky = results.filter(({ run }) => run?.flaky).length;
        const failed = results.length - passed - flaky;
        const intent = intents.find((intent) => intent.batchId === batch.id);
        const deployment = intent?.intent.reason && /deploy|application update/i.test(intent.intent.reason);
        const prefix = deployment ? "After the deployment" : batch.ci ? "CI check" : "Check run";
        const result = failed === 0 && flaky === 0 ? "all passed" : [passed ? `${passed} passed` : "", flaky ? `${flaky} passed on retry` : "", failed ? `${failed} failed` : ""].filter(Boolean).join(", ");
        const title = running ? `${prefix}: running ${countLabel(batch.specs.length, "check")}` : `${prefix}: ${countLabel(batch.specs.length, "check")} ran, ${result}`;
        const updatedAt = [new Date(Date.parse(batch.startedAt) + (batch.durationMs ?? 0)).toISOString(),
            ...results.flatMap(({ run, retry }) => run ? [finishedAt(retry ?? run)] : [])].sort().at(-1)!;
        const details = results.map(({ entry, run }) => `${entry.title}: ${run?.flaky ? "passed on retry" : run?.status ?? entry.status}${run?.failReason ? `\n${run.failReason}` : ""}`).join("\n\n");
        const story: ActivityStory = {
            id: `batch:${batch.id}`, subject: { type: deployment ? "deployment" : "project", id: batch.id, name: deployment ? "Application deployment" : batch.label },
            title, summary: "", status: running ? "working" : "completed", outcome: running ? undefined : failed ? "failed" : flaky ? "flaky" : "passed", nextStep: running ? "Results will appear here when the checks finish." : failed ? "Open a failed check to inspect its evidence." : "",
            createdAt: batch.startedAt, updatedAt, timeline: results.map(({ entry, run, retry }) => ({ id: entry.runId, label: entry.title, specId: entry.specId, runId: retry?.id ?? entry.runId,
                detail: run?.flaky ? "Passed on retry." : run?.automationPending ? retry?.status === "running" ? "Running again after a failure." : "Waiting for the failure retry." : `${run?.status ?? entry.status}.`,
                createdAt: run ? finishedAt(retry ?? run) : updatedAt })).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
            jobIds: [], inboxIds: [], technicalDetails: await clean(details),
        };
        if (running) batchStories.push(story); else history.push(story);
    }
    const suppliedByBatch = (story: ActivityStory) => !story.jobIds.length && intents.some((intent) => activeBatchIntents.has(intent.id)
        && (intent.intent.specIds?.includes(story.specId ?? "") || story.subject.type === "deployment" || story.subject.type === "project"));
    const working = [...view.activity.filter((story) => story.status === "working" && !suppliedByBatch(story)), ...batchStories];
    const queued = view.activity.filter((story) => story.status === "queued").sort(oldestFirst);

    for (const spec of specs) for (const run of runLists.get(spec.id) ?? []) {
        if (run.retryOf || batchRunIds.has(run.id)) continue;
        const running = run.status === "running" || run.automationPending;
        const retry = run.flaky ? await runsRepository.retryFor(run.id) : null;
        const story: ActivityStory = {
            id: `run:${run.id}`, subject: { type: "spec", id: spec.id, name: spec.title }, specId: spec.id, runId: retry?.id ?? run.id,
            title: running ? `Checking “${spec.title}”${run.status === "running" ? "" : " again after a failure"}`
                : `“${spec.title}” ${run.flaky ? "passed on retry" : run.status === "passed" ? "passed" : "failed its test run"}`,
            summary: "", status: running ? "working" : "completed", outcome: running ? undefined : run.flaky ? "flaky" : run.status === "passed" ? "passed" : "failed", nextStep: running ? "The result will appear here when the check finishes." : run.status === "passed" || run.flaky ? "" : "Open the check to inspect its evidence.",
            createdAt: run.startedAt, updatedAt: finishedAt(retry ?? run), timeline: [], jobIds: [], inboxIds: [], technicalDetails: await clean(run.failReason ?? ""),
        };
        if (running) {
            if (!working.some((entry) => entry.runId === run.id)) working.push(story);
        } else history.push(story);
    }
    for (const item of view.items.filter((item) => !pending(item))) {
        const base = view.activity.find((story) => story.id === item.presentation.activityId);
        if (!base) continue;
        const name = base.subject.name;
        const title = item.status === "approved" ? item.kind === "spec_fix" ? `Updated “${name}” (you approved)`
            : item.kind === "new_spec" ? `Added a check for “${String((item.payload.params as Record<string, unknown> | undefined)?.title ?? name)}” (you approved)` : `Added “${name}” to the project (you approved)`
            : item.status === "answered" ? `You answered the question about “${name}”`
            : item.kind === "bug_report" ? `Closed the report: ${item.presentation.title}` : `You set aside the suggestion for “${name}”`;
        history.push({ ...base, id: `item:${item.id}`, title, summary: item.presentation.summary, status: "completed", outcome: "reviewed", nextStep: "", createdAt: item.createdAt, updatedAt: item.updatedAt,
            jobIds: [item.jobId], inboxIds: [item.id], timeline: [{ id: item.id, label: item.status === "approved" ? "Saved" : item.status === "answered" ? "Answered" : "Reviewed", detail: title, createdAt: item.updatedAt }], technicalDetails: item.presentation.technicalDetails });
    }
    for (const job of jobs.filter((job) => ["completed", "cancelled"].includes(job.status) && job.kind !== "planner" && !job.systemError)) {
        if (view.items.some((item) => item.jobId === job.id)) continue;
        const base = view.activity.find((story) => story.jobIds.includes(job.id));
        if (!base) continue;
        const actions = await jobsRepository.actions(job.id);
        if (actions.some((action) => action.action === "error" && isInfrastructureFailure(action.detail ?? ""))) continue;
        const verb = job.status === "cancelled" ? "Stopped reviewing" : job.kind === "coverage" ? "Finished reviewing coverage for" : job.kind === "explore" ? "Finished exploring" : "Finished reviewing";
        history.push({ ...base, id: `job:${job.id}`, title: `${verb} “${base.subject.name}”`, summary: "", status: job.status === "cancelled" ? "stopped" : "completed", outcome: job.status === "cancelled" ? "stopped" : "reviewed",
            nextStep: "", createdAt: job.createdAt, updatedAt: job.updatedAt, jobIds: [job.id], inboxIds: [], timeline: [],
            technicalDetails: await clean(actions.map((action) => `${action.action}${action.detail ? `: ${action.detail}` : ""}`).join("\n")) });
    }
    working.sort(oldestFirst);
    history.sort(newestFirst);
    const lastCheckedAt = [...runLists.values()].flat().filter((run) => run.status !== "running").map(finishedAt).sort().at(-1) ?? null;
    const verdict = [specs.length ? `${healthCounts.passing} of ${specs.length} checks passing` : "No checks yet",
        problems.length ? `${countLabel(problems.length, "problem")} found` : "", needsYou.length ? `${needsYou.length} ${needsYou.length === 1 ? "needs" : "need"} you` : ""].filter(Boolean).join(" · ");
    const agentPaused = view.summary.paused || view.summary.globallyPaused;
    const nextCheckAt = agentPaused ? null : schedule?.nextRunAt ?? null;
    const nextCheck = agentPaused ? "Resume Specbook to continue."
        : settings.autonomy === "observe" ? "Observation mode records changes without starting investigations."
        : working.length ? `${countLabel(working.length, "check")} in progress.`
        : nextCheckAt ? "Next scheduled check"
        : "Checks run when the application or its checks change.";
    return { summary: { ...view.summary, verdict, nextCheck, nextCheckAt, problemCount: problems.length, attentionCount: needsYou.length,
        activeCount: working.length, queuedCount: queued.length, pausedCount: paused.reduce((count, group) => count + group.count, 0), lastCheckedAt, specHealth: healthCounts },
        specHealth, needsYou, working, queued, problems, paused, history: history.slice(0, 100), items: view.items, stories: view.activity };
}
