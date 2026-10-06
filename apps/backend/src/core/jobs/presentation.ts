import fs from "node:fs/promises";
import path from "node:path";
import { featuresRepository } from "../../infra/repositories/features";
import { jobsRepository, type InboxItem, type Job } from "../../infra/repositories/jobs";
import { projectsRepository } from "../../infra/repositories/projects";
import { runsRepository } from "../../infra/repositories/runs";
import { settingsRepository } from "../../infra/repositories/settings";
import { specsRepository, type Spec } from "../../infra/repositories/specs";
import { stewardRepository, type Intent, type ProjectSignal, type Steward } from "../../infra/repositories/steward";
import { projectSecretScrubber } from "../credentials/scrub";
import { runsDir } from "../paths";
import { readSpecRawFiles } from "../repo/manual";
import { sourceHashOf } from "../repo/writer";
import { proposalFiles } from "./preview";
import { isInfrastructureFailure, sanitizeTechnicalDetails } from "./presentation-errors";
import type { ProposalVerification } from "./verification";
import { presentSpecBatch } from "./spec-batches";
import { ACTIVE_JOB_STATUSES, oldestFirst } from "./shared";

interface Subject { type: "spec" | "feature" | "deployment" | "project"; id?: string; name: string }
interface Screenshot { url: string; label: string }
export type PresentedItem = Omit<InboxItem, "payload"> & { payload: Record<string, unknown>; presentation: InboxPresentation };
export interface InboxPresentation {
    type: "update" | "new_check" | "batch" | "feature" | "bug" | "question" | "help";
    title: string;
    summary: string;
    workDone: string;
    consequence: string;
    screenshots: { before?: Screenshot; after?: Screenshot };
    specId?: string;
    chatId?: string;
    activityId: string;
    credentialRequest: boolean;
}
export interface ActivityStory {
    id: string;
    subject: Subject;
    title: string;
    summary: string;
    status: "working" | "queued" | "waiting" | "needs_attention" | "paused" | "completed" | "observing" | "stopped";
    outcome?: "passed" | "failed" | "flaky" | "stopped" | "reviewed";
    nextStep: string;
    createdAt: string;
    updatedAt: string;
    timeline: { id: string; label: string; detail: string; createdAt: string; specId?: string; runId?: string }[];
    jobIds: string[];
    inboxIds: string[];
    specId?: string;
    runId?: string;
}
export interface ProjectState {
    jobs: Job[];
    specs: Spec[];
    intents: Intent[];
    signals: ProjectSignal[];
    settings: Steward;
    clean: (text: string) => string;
}
type SpecBatch = Awaited<ReturnType<typeof presentSpecBatch>>;

const ITEM_TYPES: Partial<Record<InboxItem["kind"], InboxPresentation["type"]>> = { spec_fix: "update", new_spec: "new_check", spec_batch: "batch", feature: "feature", bug_report: "bug" };
const CONSEQUENCES: Record<InboxPresentation["type"], string> = {
    update: "Saves the updated Spec to this project; you can undo it from history.",
    new_check: "Adds the Spec to this project; future runs can verify this behavior.",
    batch: "Creates only the Specs you select. Each one is validated and run once.",
    feature: "Adds a feature to organize this project’s Specs.",
    bug: "Requests a regression Spec for review. The current Spec stays unchanged.",
    help: "Discuss it in chat, or set this suggestion aside without changing the Spec.",
    question: "Your answer lets Specbook continue with this Spec.",
};
const NOTICED_TEXT: Record<string, string> = {
    invalid_spec: "The current Spec could not run.", spec_failure: "A test run did not complete as expected.", spec_changed: "The Spec was edited.",
    deployment: "A new deployment was reported.", deployment_changed: "An application update was detected.",
};

const active = (status: string) => ["running", "queued", "blocked", "paused"].includes(status);
const awaiting = (item: InboxItem) => ["pending", "applying"].includes(item.status);
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const subjectKey = (subject: Subject) => `${subject.type}:${subject.id ?? subject.name}`;
const newestFirst = (a: { updatedAt: string }, b: { updatedAt: string }) => b.updatedAt.localeCompare(a.updatedAt);
function firstBy<T>(rows: T[], key: (row: T) => string | null | undefined): Map<string, T> {
    const map = new Map<string, T>();
    for (const row of rows) {
        const value = key(row);
        if (value && !map.has(value)) map.set(value, row);
    }
    return map;
}

function plainExcerpt(text: string): string | null {
    const clean = sanitizeTechnicalDetails(text).replace(/\s+/g, " ").trim();
    if (!clean || /(?:Error:|Timeout|spec\.ts|spec\.yml|\bjob\b|\bsteward\b|\bbudget\b|\bverification\b|\bcommit\b|\bproposal\b|\bgetByRole\b|[{}]|\[server path\])/i.test(clean)) return null;
    return clean.split(/(?<=[.!?])\s/).slice(0, 2).join(" ").slice(0, 400);
}

function plainReason(text: string): string {
    if (/origin is not allowed|allowed origins/i.test(text)) return "The saved sign-in details are not allowed on this application address.";
    if (/credential|password|sign.?in|log.?in|session expired|credencia/i.test(text)) return "The Spec needs access to the application before it can continue.";
    if (/ERR_CONNECTION|ERR_NAME|unreachable|could not be reached|HTTP 50[234]/i.test(text)) return "The application could not be reached.";
    if (/timeout|timed out|toBeVisible|toHaveText|locator/i.test(text)) return "An expected button or result was not available during the test run.";
    if (/invalid|cannot run|validation|not allowed|parse/i.test(text)) return "The current Spec could not run as written.";
    return plainExcerpt(text) ?? "The Spec still needs attention before it can run successfully.";
}

function batchTitle(item: InboxItem, batch: SpecBatch): string {
    if (item.status !== "approved") return `Which of these ${batch.candidates.length} Specs would you like to add?`;
    const selected = batch.candidates.filter((candidate) => candidate.selected);
    const finished = selected.filter((candidate) => ["passed", "failed", "stopped"].includes(candidate.state));
    return finished.length === selected.length
        ? `${selected.length} selected Spec${selected.length === 1 ? "" : "s"}: ${selected.filter((candidate) => candidate.state === "passed").length} passed${selected.some((candidate) => candidate.state !== "passed") ? ", review the remaining results" : ""}`
        : `Creating selected Specs: ${finished.length} of ${selected.length} finished`;
}

async function screenshotsFor(projectId: string, item: InboxItem, job: Job | undefined, specsById: Map<string, Spec>): Promise<InboxPresentation["screenshots"]> {
    const screenshots: InboxPresentation["screenshots"] = {};
    const runId = string(item.payload.runId) ?? job?.runId;
    let beforeFile: string | undefined;
    if (runId && /^[a-f0-9-]{36}$/.test(runId)) {
        const run = await runsRepository.getRun(runId);
        if (run && specsById.has(run.specId)) {
            const manifest = JSON.parse(await fs.readFile(path.join(runsDir, runId, "evidence.json"), "utf8").catch(() => "{}")) as { failedStep?: string; steps?: { label: string; file: string }[] };
            const step = manifest.steps?.find((entry) => entry.label === manifest.failedStep) ?? manifest.steps?.at(-1);
            if (step && /^evidence\/step-\d{2,3}\.png$/.test(step.file)) {
                beforeFile = step.file;
                screenshots.before = { url: `/runs/${runId}/artifacts/${step.file}`, label: "When the Spec failed" };
            }
        }
    }
    const verification = item.payload.verification as ProposalVerification | undefined;
    const afterFile = beforeFile ? verification?.screenshots?.find((file) => file === beforeFile) : verification?.screenshots?.at(-1);
    if (afterFile && /^evidence\/step-\d{2,3}\.png$/.test(afterFile)) screenshots.after = {
        url: `/projects/${projectId}/inbox/${item.id}/evidence/${afterFile}`, label: verification?.status === "passed" ? "After the update" : "Latest attempt",
    };
    return screenshots;
}

export async function loadProjectState(projectId: string): Promise<ProjectState> {
    const [jobs, specs, intents, signals, settings, scrub] = await Promise.all([
        jobsRepository.list(projectId), specsRepository.listSpecs(projectId), stewardRepository.intents(projectId), stewardRepository.signals(projectId),
        stewardRepository.get(projectId), projectSecretScrubber(projectId),
    ]);
    return { jobs, specs, intents, signals, settings, clean: (text) => sanitizeTechnicalDetails(scrub(text)) };
}

export async function projectPresentation(projectId: string, state?: ProjectState) {
    const [project, inbox, features, globallyPaused, { jobs, specs, intents, signals, settings, clean }] = await Promise.all([
        projectsRepository.getProject(projectId), jobsRepository.inbox(projectId), featuresRepository.listFeatures(projectId),
        settingsRepository.getAgentPaused(), state ?? loadProjectState(projectId),
    ]);
    if (!project) throw new Error("Project not found");
    const agentPaused = settings.paused || globallyPaused;
    const jobsById = new Map(jobs.map((job) => [job.id, job]));
    const specsById = new Map(specs.map((spec) => [spec.id, spec]));
    const featuresById = new Map(features.map((feature) => [feature.id, feature]));
    const signalsByKey = new Map(signals.map((signal) => [`signal:${signal.id}`, signal]));
    const intentsByJob = firstBy(intents, (intent) => intent.jobId);
    const itemsByJob = firstBy(inbox.filter((item) => item.kind !== "note"), (item) => item.jobId);
    const actions = await jobsRepository.actionsByJob(jobs.slice(0, 100).map((job) => job.id));
    const projectSubject: Subject = { type: "project", id: projectId, name: project.name };
    const specSubject = (id: string | undefined | null): Subject | undefined => {
        const spec = id ? specsById.get(id) : undefined;
        return spec ? { type: "spec", id: spec.id, name: spec.title } : undefined;
    };
    const featureSubject = (id: string | undefined): Subject | undefined => {
        const feature = id ? featuresById.get(id) : undefined;
        return feature ? { type: "feature", id: feature.id, name: feature.title } : undefined;
    };
    const forSignal = (signal: ProjectSignal): Subject => {
        if (["deployment", "deployment_changed"].includes(signal.kind)) return { type: "deployment", id: `${string(signal.payload.environment) ?? "app"}:${string(signal.payload.url) ?? project.baseUrl}`, name: string(signal.payload.environment) ? `${signal.payload.environment} deployment` : "Application updates" };
        return specSubject(Array.isArray(signal.payload.specIds) ? string(signal.payload.specIds[0]) : undefined) ?? featureSubject(string(signal.payload.featureId)) ?? projectSubject;
    };
    const forIntent = (intent: Intent): Subject => {
        const signal = signalsByKey.get(intent.key);
        return signal ? forSignal(signal) : specSubject(intent.intent.specIds?.[0]) ?? projectSubject;
    };
    const itemSubjects = new Map(inbox.map((item) => {
        const params = record(item.payload.params);
        const job = jobsById.get(item.jobId);
        const intent = job && intentsByJob.get(job.id);
        return [item.id, specSubject(string(params.specId) ?? string(item.payload.specId) ?? job?.specId)
            ?? featureSubject(string(params.featureId)) ?? (intent ? forIntent(intent) : projectSubject)] as const;
    }));
    const forJob = (job: Job): Subject => {
        const item = itemsByJob.get(job.id);
        const intent = intentsByJob.get(job.id);
        return specSubject(job.specId) ?? (item ? itemSubjects.get(item.id)! : intent ? forIntent(intent) : projectSubject);
    };
    const awaitingSpecIds = new Set(inbox.filter(awaiting).map((item) => record(item.payload.params).specId));
    const rawSpecs = new Map(await Promise.all(specs.filter((spec) => awaitingSpecIds.has(spec.id))
        .map(async (spec) => [spec.id, await readSpecRawFiles(spec).catch(() => null)] as const)));
    const infrastructureQuestions = new Set(inbox.filter((item) => item.kind === "question" && awaiting(item) && isInfrastructureFailure(`${item.title}\n${item.body}`)).map((item) => item.jobId));
    const infrastructureJobs = new Set(jobs.filter((job) => !["completed", "cancelled"].includes(job.status) && (Boolean(job.systemError) || infrastructureQuestions.has(job.id))).map((job) => job.id));
    const newestAwaiting = new Map<string, string>();
    for (const item of inbox.filter(awaiting)) {
        const key = subjectKey(itemSubjects.get(item.id)!);
        if (item.createdAt > (newestAwaiting.get(key) ?? "")) newestAwaiting.set(key, item.createdAt);
    }
    const items: PresentedItem[] = [];
    for (const item of inbox) {
        if (item.kind === "note" || item.payload.retiredByScope === true) continue;
        const job = jobsById.get(item.jobId);
        if (job && infrastructureJobs.has(job.id)) continue;
        const subject = itemSubjects.get(item.id)!;
        const params = record(item.payload.params);
        const before = record(item.payload.before);
        const verification = item.payload.verification as ProposalVerification | undefined;
        const diagnostic = `${item.title}\n${item.body}\n${verification?.failReason ?? ""}`;
        if (item.kind !== "bug_report" && isInfrastructureFailure(diagnostic)) continue;
        if (item.kind === "question" && awaiting(item) && job?.status !== "blocked") continue;
        const patchSpecId = string(params.specId);
        if (item.kind === "spec_fix" && awaiting(item)) {
            const raw = patchSpecId ? rawSpecs.get(patchSpecId) : null;
            if (!raw || (typeof before.yaml === "string" && raw.yaml !== before.yaml) || ("testSource" in before && raw.testSource !== before.testSource)) continue;
        }
        const verified = verification?.status === "passed" && (!params.testSource || verification.sourceHash === sourceHashOf(String(params.testSource)));
        const unfinished = item.payload.requiresVerification === true && !verified;
        if (unfinished && awaiting(item) && job && (active(job.status) || (job.status === "stalled" && job.retryAt))) continue;
        if (unfinished && awaiting(item) && (newestAwaiting.get(subjectKey(subject)) ?? "") > item.createdAt) continue;
        const batch = item.kind === "spec_batch" ? await presentSpecBatch(item) : undefined;
        const type = unfinished && awaiting(item) ? "help" : ITEM_TYPES[item.kind] ?? "question";
        const credentialRequest = item.payload.waitingFor === "credentials";
        const name = subject.type === "project" ? string(params.title) ?? "this Spec" : subject.name;
        const safeTitle = plainExcerpt(item.title)?.replace(/^(?:Bug report|Possible bug):\s*/i, "");
        let title: string;
        let summary: string;
        switch (type) {
            case "help":
                title = `I couldn’t update “${name}” by myself. Look at it together?`;
                summary = plainReason(verification?.failReason ?? job?.stopReason ?? item.body);
                break;
            case "update": {
                if (params.humanSpec !== undefined || params.title !== undefined || params.description !== undefined) {
                    title = `Change what “${name}” verifies?`;
                    summary = "This suggestion changes the behavior described by the Spec. Review the expected result before saving it.";
                    break;
                }
                title = `Update the Spec “${name}”?`;
                if (!verified) {
                    summary = "Review this suggested update to the Spec before saving it to the project.";
                    break;
                }
                const originalRunId = string(item.payload.runId) ?? job?.runId;
                const originalRun = originalRunId ? await runsRepository.getRun(originalRunId) : null;
                const originalReason = originalRun && specsById.has(originalRun.specId) ? originalRun.failReason : patchSpecId ? specsById.get(patchSpecId)?.invalidReason : undefined;
                const updateReason = originalReason ? plainReason(clean(originalReason)).replace(/[.!?]+$/, "") + "." : "This suggestion updates how the Spec runs.";
                summary = `${updateReason} The expected behavior stays the same.`;
                break;
            }
            case "new_check":
                title = `Add a Spec for “${string(params.title) ?? name}”?`;
                summary = "This would add a Spec for a behavior that is not yet covered. Review the steps and expected result before saving it.";
                break;
            case "batch":
                title = batchTitle(item, batch!);
                summary = batch!.contextReviewRequired ? "Confirm the discovery context, then select the Specs you want to create."
                    : item.status === "approved" ? "Each selected Spec is saved, validated and run once. Review its first result." : "Select the Specs you want. Each one will be created, validated and run once.";
                break;
            case "feature":
                title = `Add “${string(params.title) ?? name}” to this project?`;
                summary = "This would organize related Specs under a new feature of the project.";
                break;
            case "bug":
                title = safeTitle?.replace(/[.!?]+$/, "") ?? `A problem was reported in “${name}”`;
                summary = plainExcerpt(item.body.split(/\n\s*\n/)[0] ?? "") ?? "The application did not behave as expected. The existing Spec has been left unchanged.";
                break;
            default:
                title = credentialRequest ? `Can you provide access for “${name}”?` : safeTitle && safeTitle.endsWith("?") ? safeTitle : `Can you clarify what should happen in “${name}”?`;
                summary = credentialRequest ? "Add the requested sign-in details in Settings, then let Specbook know. Do not put passwords in your reply."
                    : plainExcerpt(item.body) ?? "Specbook needs your explanation of the expected behavior before it can continue. Discuss the Spec in chat to clarify it.";
        }
        const browserWork = actions.get(item.jobId)?.some((action) => /(?:browser_|scan_page).*:completed$/.test(action.action));
        const workDone = type === "batch" ? "" : verification ? verification.status === "passed" ? "Tried the suggested update in a test run; it passed." : "Tried an update, but the test run did not pass."
            : type === "question" ? "Paused here so your answer can guide the next step." : browserWork ? "Inspected the application and recorded the available evidence." : "Prepared this suggestion for your review.";
        const files = await proposalFiles(item).catch(() => []);
        const presentation: InboxPresentation = { type, title, summary, workDone, consequence: CONSEQUENCES[type], credentialRequest,
            screenshots: await screenshotsFor(projectId, item, job, specsById).catch(() => ({})), activityId: subjectKey(subject),
            specId: subject.type === "spec" ? subject.id : undefined, chatId: job?.chatId };
        items.push({ ...item, title, body: summary, payload: { ...item.payload, files, ...(batch ? { specBatch: batch } : {}),
            ...(verification ? { verification: { ...verification, failReason: verification.failReason ? clean(verification.failReason) : null } } : {}) }, presentation });
    }
    const groups = new Map<string, { subject: Subject; jobs: Job[]; signals: ProjectSignal[]; intents: Intent[]; items: PresentedItem[] }>();
    const group = (subject: Subject) => {
        const key = subjectKey(subject);
        let value = groups.get(key);
        if (!value) { value = { subject, jobs: [], signals: [], intents: [], items: [] }; groups.set(key, value); }
        return value;
    };
    for (const signal of signals.filter((signal) => !["job_completed", "credentials_changed"].includes(signal.kind))) group(forSignal(signal)).signals.push(signal);
    for (const intent of intents) {
        const job = intent.jobId ? jobsById.get(intent.jobId) : undefined;
        if (!job || !infrastructureJobs.has(job.id)) group(job ? forJob(job) : forIntent(intent)).intents.push(intent);
    }
    for (const job of jobs) if (!infrastructureJobs.has(job.id)) group(forJob(job)).jobs.push(job);
    for (const item of items) group(itemSubjects.get(item.id)!).items.push(item);
    const activity: ActivityStory[] = [];
    for (const [id, value] of groups) {
        const { subject } = value;
        const orderedJobs = value.jobs.sort(newestFirst);
        const latestJob = orderedJobs[0];
        const decisions = value.items.filter((item) => awaiting(item) && item.kind !== "bug_report");
        const questions = decisions.filter((item) => item.presentation.type === "question");
        const pendingIntent = value.intents.find((intent) => intent.status === "pending");
        const paused = agentPaused && (Boolean(pendingIntent) || orderedJobs.some((job) => ACTIVE_JOB_STATUSES.includes(job.status)));
        const running = orderedJobs.some((job) => job.status === "running") || value.intents.some((intent) => intent.batchId && intent.status === "running");
        const queued = orderedJobs.some((job) => job.status === "queued" || (job.status === "stalled" && job.retryAt)) || Boolean(pendingIntent);
        const status: ActivityStory["status"] = questions.some((item) => item.presentation.credentialRequest) ? "waiting" : decisions.length ? "needs_attention"
            : paused ? "paused" : running ? "working" : queued ? settings.autonomy === "observe" ? "observing" : "queued" : latestJob?.status === "cancelled" || latestJob?.status === "stalled" ? "stopped"
            : latestJob?.status === "completed" || value.items.some((item) => ["approved", "answered", "dismissed"].includes(item.status)) || value.intents.some((intent) => intent.status === "completed") ? "completed" : "observing";
        const noticed = value.signals.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        const latestItem = value.items.sort(newestFirst)[0];
        const currentSpec = subject.id ? specsById.get(subject.id) : undefined;
        const failureRunId = string(noticed?.payload.runId) ?? latestJob?.runId;
        const failureRun = failureRunId ? await runsRepository.getRun(failureRunId) : null;
        const failureReason = failureRun && specsById.has(failureRun.specId) && failureRun.failReason
            ? plainReason(clean(failureRun.failReason)) : undefined;
        const invalidReason = currentSpec?.invalidReason ?? noticed?.body ?? "";
        const invalidTitle = /missing.*spec\.ts|spec\.ts.*missing|no.*spec\.ts/i.test(invalidReason)
            ? `The Spec “${subject.name}” has no executable source`
            : `The Spec “${subject.name}” needs an update before it can run`;
        const title = subject.type === "spec" ? status === "completed" ? `“${subject.name}” was checked`
            : noticed?.kind === "spec_failure" ? `“${subject.name}”: ${failureReason ? failureReason.charAt(0).toLowerCase() + failureReason.slice(1).replace(/[.!?]+$/, "") : "the latest test run failed"}`
            : noticed?.kind === "invalid_spec" || currentSpec?.status === "invalid" ? invalidTitle
            : noticed?.kind === "spec_changed" ? `“${subject.name}” changed` : `Reviewing “${subject.name}”`
            : subject.type === "deployment" ? status === "completed" ? "Checked the application after an update" : "Checking the application after an update"
            : subject.type === "feature" ? `Looking for missing Specs in “${subject.name}”`
            : latestJob?.kind === "coverage" ? `Looking for missing Specs in ${project.name}`
            : latestJob?.kind === "explore" ? `Exploring ${project.name} for application problems`
            : `Reviewing changes to ${project.name}’s Specs`;
        const nextStep = status === "waiting" ? "Add the requested access in Settings, then answer the question."
            : status === "needs_attention" ? "Review the suggestion, or discuss the Spec in chat."
            : status === "working" ? "Specbook is investigating. You can keep using the project."
            : status === "paused" ? globallyPaused ? "Resume Specbook for all projects in Settings to continue." : "Resume Specbook from the Overview header to continue."
            : status === "queued" ? latestJob?.status === "stalled" ? "Specbook will try this Spec again with a different approach." : latestJob?.retryAt && latestJob.classification === "environment" ? "The application could not be reached. Specbook will try again shortly." : "Starts when a worker is available."
            : status === "stopped" ? "Discuss the Spec in chat if you want to pick it up again."
            : settings.autonomy === "observe" ? "Observation mode records changes. Choose Propose or Act in Automation settings to investigate them."
            : "Specbook will check again when the application or its Specs change.";
        const summary = decisions[0]?.presentation.summary ?? failureReason ?? (noticed ? NOTICED_TEXT[noticed.kind] : undefined) ?? "";
        const timeline: ActivityStory["timeline"] = [];
        const noticedDetail = noticed?.kind === "invalid_spec" ? plainReason(clean(invalidReason)) : noticed ? NOTICED_TEXT[noticed.kind] : undefined;
        if (noticed && noticedDetail && noticedDetail !== summary) timeline.push({ id: noticed.id, label: "Noticed", detail: noticedDetail, createdAt: noticed.createdAt });
        for (const item of value.items) {
            if (!item.payload.verification) continue;
            const verifiedAction = actions.get(item.jobId)?.find((action) => action.action === "proposal:verified" && action.detail?.startsWith(`${item.id}:`));
            if (verifiedAction) timeline.push({ id: `${item.id}:test`, label: "Tested update", detail: item.presentation.workDone, createdAt: verifiedAction.createdAt });
        }
        if (latestItem?.kind === "spec_batch") {
            const batch = latestItem.payload.specBatch as SpecBatch;
            const selected = batch.candidates.filter((candidate) => candidate.selected);
            timeline.push({ id: latestItem.id, label: latestItem.status === "approved" ? "Selected" : "Suggested",
                detail: latestItem.status === "approved" ? `${selected.length} Spec${selected.length === 1 ? "" : "s"} selected to create.` : latestItem.presentation.title,
                createdAt: batch.selectedAt ?? latestItem.createdAt });
            for (const candidate of selected) if (candidate.runId && candidate.finishedAt) timeline.push({ id: candidate.runId, label: "First run",
                detail: `“${candidate.title}” ${candidate.state === "passed" ? "passed" : "did not pass"}.`, createdAt: candidate.finishedAt, specId: candidate.specId, runId: candidate.runId });
        } else if (latestItem) timeline.push({ id: latestItem.id, label: awaiting(latestItem) ? latestItem.kind === "bug_report" ? "Problem found" : "Your decision" : latestItem.status === "approved" ? "Saved" : latestItem.status === "answered" ? "Answered" : "Reviewed",
            detail: awaiting(latestItem) ? latestItem.presentation.title : latestItem.status === "approved" ? `Saved the approved change to “${subject.name}”.` : latestItem.status === "answered" ? `Received your answer about “${subject.name}”.` : `Set aside the suggestion for “${subject.name}”.`, createdAt: latestItem.updatedAt });
        else if (paused && latestJob) timeline.push({ id: `${latestJob.id}:pause`, label: "Paused by you", detail: globallyPaused ? "Specbook is paused across all projects." : "Specbook is paused for this project.", createdAt: settings.updatedAt });
        timeline.sort(oldestFirst);
        const times = [...value.signals.map((signal) => signal.createdAt), ...value.jobs.flatMap((job) => [job.createdAt, job.updatedAt]), ...value.intents.flatMap((intent) => [intent.createdAt, intent.updatedAt]), ...value.items.map((item) => item.updatedAt)].sort();
        activity.push({ id, subject, title, status, nextStep, createdAt: times[0] ?? project.createdAt, updatedAt: times.at(-1) ?? project.createdAt,
            summary,
            timeline, jobIds: orderedJobs.map((job) => job.id), inboxIds: value.items.map((item) => item.id), specId: subject.type === "spec" ? subject.id : undefined,
            runId: latestJob?.runId ?? undefined });
    }
    activity.sort(newestFirst);
    const systemHealth = jobs.some((job) => infrastructureJobs.has(job.id)) ? { message: "Specbook is recovering from a service problem. Your app and its Specs are unchanged, and runs resume automatically." } : undefined;
    return { items, activity, summary: { projectName: project.name, paused: settings.paused, globallyPaused, systemHealth } };
}
