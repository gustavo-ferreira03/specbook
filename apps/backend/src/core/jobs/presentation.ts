import fs from "node:fs/promises";
import path from "node:path";
import { featuresRepository } from "../../infra/repositories/features";
import { jobsRepository, type InboxItem, type Job } from "../../infra/repositories/jobs";
import { projectsRepository } from "../../infra/repositories/projects";
import { runsRepository } from "../../infra/repositories/runs";
import { settingsRepository } from "../../infra/repositories/settings";
import { specsRepository, type Spec } from "../../infra/repositories/specs";
import { stewardRepository, type Intent, type ProjectSignal } from "../../infra/repositories/steward";
import { createProjectScrubber } from "../credentials/scrub";
import { runsDir } from "../paths";
import { readSpecRawFiles } from "../repo/manual";
import { sourceHashOf } from "../repo/writer";
import { proposalFiles } from "./preview";
import { isInfrastructureFailure, sanitizeTechnicalDetails } from "./presentation-errors";
import type { ProposalVerification } from "./verification";

interface Subject { type: "spec" | "feature" | "deployment" | "project"; id?: string; name: string }
interface Screenshot { url: string; label: string }
export type PresentedItem = Omit<InboxItem, "payload"> & { payload: Record<string, unknown>; presentation: InboxPresentation };
export interface InboxPresentation {
    type: "update" | "new_check" | "feature" | "bug" | "question" | "help";
    title: string;
    summary: string;
    workDone: string;
    consequence: string;
    screenshots: { before?: Screenshot; after?: Screenshot };
    technicalDetails: string;
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
    technicalDetails: string;
}

const active = (status: string) => ["running", "queued", "blocked", "paused"].includes(status);
const awaiting = (item: InboxItem) => ["pending", "applying"].includes(item.status);
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const subjectKey = (subject: Subject) => `${subject.type}:${subject.id ?? subject.name}`;

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

async function screenshotsFor(projectId: string, item: InboxItem, job: Job | undefined, specs: Spec[]): Promise<InboxPresentation["screenshots"]> {
    const screenshots: InboxPresentation["screenshots"] = {};
    const runId = string(item.payload.runId) ?? job?.runId;
    let beforeFile: string | undefined;
    if (runId && /^[a-f0-9-]{36}$/.test(runId)) {
        const run = await runsRepository.getRun(runId);
        if (run && specs.some((spec) => spec.id === run.specId)) {
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

export async function projectPresentation(projectId: string) {
    const [project, jobs, inbox, specs, features, signals, intents, settings, globallyPaused] = await Promise.all([
        projectsRepository.getProject(projectId), jobsRepository.list(projectId), jobsRepository.inbox(projectId), specsRepository.listSpecs(projectId),
        featuresRepository.listFeatures(projectId), stewardRepository.signals(projectId), stewardRepository.intents(projectId), stewardRepository.get(projectId),
        settingsRepository.getAgentPaused(),
    ]);
    if (!project) throw new Error("Project not found");
    const agentPaused = settings.paused || globallyPaused;
    const scrub = createProjectScrubber(projectId);
    const clean = async (text: string) => sanitizeTechnicalDetails(await scrub(text));
    const jobsById = new Map(jobs.map((job) => [job.id, job]));
    const actions = new Map(await Promise.all(jobs.slice(0, 100).map(async (job) => [job.id, await jobsRepository.actions(job.id)] as const)));
    const projectSubject: Subject = { type: "project", id: projectId, name: project.name };
    const specSubject = (id: string | undefined): Subject | undefined => {
        const spec = specs.find((row) => row.id === id);
        return spec ? { type: "spec", id: spec.id, name: spec.title } : undefined;
    };
    const featureSubject = (id: string | undefined): Subject | undefined => {
        const feature = features.find((row) => row.id === id);
        return feature ? { type: "feature", id: feature.id, name: feature.title } : undefined;
    };
    const forSignal = (signal: ProjectSignal): Subject => {
        if (["deployment", "deployment_changed"].includes(signal.kind)) return { type: "deployment", id: `${string(signal.payload.environment) ?? "app"}:${string(signal.payload.url) ?? project.baseUrl}`, name: string(signal.payload.environment) ? `${signal.payload.environment} deployment` : "Application updates" };
        return specSubject(Array.isArray(signal.payload.specIds) ? string(signal.payload.specIds[0]) : undefined) ?? featureSubject(string(signal.payload.featureId)) ?? projectSubject;
    };
    const forIntent = (intent: Intent): Subject => {
        const signal = signals.find((signal) => `signal:${signal.id}` === intent.key);
        return signal ? forSignal(signal) : specSubject(intent.intent.specIds?.[0]) ?? projectSubject;
    };
    const forItem = (item: InboxItem, job = jobsById.get(item.jobId)): Subject => {
        const params = record(item.payload.params);
        const intent = intents.find((row) => row.jobId === job?.id);
        return specSubject(string(params.specId) ?? string(item.payload.specId) ?? job?.specId ?? undefined)
            ?? featureSubject(string(params.featureId)) ?? (intent ? forIntent(intent) : projectSubject);
    };
    const forJob = (job: Job): Subject => {
        const item = inbox.find((item) => item.jobId === job.id && item.kind !== "note");
        const intent = intents.find((row) => row.jobId === job.id);
        return specSubject(job.specId ?? undefined) ?? (item ? forItem(item, job) : intent ? forIntent(intent) : projectSubject);
    };
    const rawSpecs = new Map(await Promise.all(specs.filter((spec) => inbox.some((item) => record(item.payload.params).specId === spec.id && awaiting(item)))
        .map(async (spec) => [spec.id, await readSpecRawFiles(spec).catch(() => null)] as const)));
    const infrastructureJobs = new Set(jobs.filter((job) => !["completed", "cancelled"].includes(job.status) && (Boolean(job.systemError)
        || inbox.some((item) => item.jobId === job.id && item.kind === "question" && awaiting(item) && isInfrastructureFailure(`${item.title}\n${item.body}`)))) .map((job) => job.id));
    const items: PresentedItem[] = [];
    for (const item of inbox) {
        if (item.kind === "note" || item.payload.retiredByScope === true) continue;
        const job = jobsById.get(item.jobId);
        if (job && infrastructureJobs.has(job.id)) continue;
        const subject = forItem(item, job);
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
        if (unfinished && awaiting(item) && inbox.some((other) => other.id !== item.id && other.createdAt > item.createdAt && awaiting(other) && subjectKey(forItem(other)) === subjectKey(subject))) continue;
        const type: InboxPresentation["type"] = unfinished && awaiting(item) ? "help" : item.kind === "spec_fix" ? "update" : item.kind === "new_spec" ? "new_check" : item.kind === "feature" ? "feature" : item.kind === "bug_report" ? "bug" : "question";
        const credentialRequest = item.payload.waitingFor === "credentials";
        const name = subject.type === "project" ? string(params.title) ?? "this Spec" : subject.name;
        const behaviorChange = item.kind === "spec_fix" && (params.humanSpec !== undefined || params.title !== undefined || params.description !== undefined);
        const safeTitle = plainExcerpt(item.title)?.replace(/^(?:Bug report|Possible bug):\s*/i, "");
        const title = type === "help" ? `I couldn’t update “${name}” by myself. Look at it together?`
            : type === "update" ? behaviorChange ? `Change what “${name}” verifies?` : `Update the Spec “${name}”?`
            : type === "new_check" ? `Add a Spec for “${string(params.title) ?? name}”?`
            : type === "feature" ? `Add “${string(params.title) ?? name}” to this project?`
            : type === "bug" ? safeTitle?.replace(/[.!?]+$/, "") ?? `A problem was reported in “${name}”`
            : credentialRequest ? `Can you provide access for “${name}”?` : safeTitle && safeTitle.endsWith("?") ? safeTitle : `Can you clarify what should happen in “${name}”?`;
        const originalRunId = string(item.payload.runId) ?? job?.runId;
        const originalRun = type === "update" && verified && originalRunId ? await runsRepository.getRun(originalRunId) : null;
        const originalReason = originalRun && specs.some((spec) => spec.id === originalRun.specId) ? originalRun.failReason
            : specs.find((spec) => spec.id === patchSpecId)?.invalidReason;
        const updateReason = originalReason ? plainReason(await clean(originalReason)).replace(/[.!?]+$/, "") + "." : "This suggestion updates how the Spec runs.";
        const summary = type === "help" ? plainReason(verification?.failReason ?? job?.stopReason ?? item.body)
            : type === "update" ? behaviorChange ? "This suggestion changes the behavior described by the Spec. Review the expected result before saving it." : verified ? `${updateReason} The expected behavior stays the same.` : "Review this suggested update to the Spec before saving it to the project."
            : type === "new_check" ? "This would add a Spec for a behavior that is not yet covered. Review the steps and expected result before saving it."
            : type === "feature" ? "This would organize related Specs under a new feature of the project."
            : type === "bug" ? plainExcerpt(item.body.split(/\n\s*\n/)[0] ?? "") ?? "The application did not behave as expected. The existing Spec has been left unchanged."
            : credentialRequest ? "Add the requested sign-in details in Settings, then let Specbook know. Do not put passwords in your reply."
            : plainExcerpt(item.body) ?? "Specbook needs your explanation of the expected behavior before it can continue. Discuss the Spec in chat to clarify it.";
        const browserWork = actions.get(item.jobId)?.some((action) => /(?:browser_|scan_page).*:completed$/.test(action.action));
        const workDone = verification ? verification.status === "passed" ? "Tried the suggested update in a test run; it passed." : "Tried an update, but the test run did not pass."
            : type === "question" ? "Paused here so your answer can guide the next step." : browserWork ? "Inspected the application and recorded the available evidence." : "Prepared this suggestion for your review.";
        const consequence = type === "update" ? "Saves the updated Spec to this project; you can undo it from history."
            : type === "new_check" ? "Adds the Spec to this project; future runs can verify this behavior."
            : type === "feature" ? "Adds an area to organize this project’s checks."
            : type === "bug" ? "Requests a regression Spec for review. The current Spec stays unchanged."
            : type === "help" ? "Discuss it in chat, or set this suggestion aside without changing the Spec." : "Your answer lets Specbook continue with this Spec.";
        const files = await proposalFiles(item).catch(() => []);
        const technicalDetails = await clean(`${item.body}${verification?.failReason ? `\n\nTest run: ${verification.failReason}` : ""}`);
        const presentation: InboxPresentation = { type, title, summary, workDone, consequence, credentialRequest,
            screenshots: await screenshotsFor(projectId, item, job, specs).catch(() => ({})), technicalDetails, activityId: subjectKey(subject),
            specId: subject.type === "spec" ? subject.id : undefined, chatId: job?.chatId };
        items.push({ ...item, title, body: summary, payload: { ...item.payload, files,
            ...(verification ? { verification: { ...verification, failReason: verification.failReason ? await clean(verification.failReason) : null } } : {}) }, presentation });
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
    for (const item of items) group(forItem(item)).items.push(item);
    let pausedCount = 0;
    const activity: ActivityStory[] = [];
    for (const [id, value] of groups) {
        const { subject } = value;
        const orderedJobs = value.jobs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        const latestJob = orderedJobs[0];
        const decisions = value.items.filter((item) => awaiting(item) && item.kind !== "bug_report");
        const questions = decisions.filter((item) => item.presentation.type === "question");
        const pendingIntent = value.intents.find((intent) => intent.status === "pending");
        const paused = agentPaused && (Boolean(pendingIntent) || orderedJobs.some((job) => ["queued", "running", "blocked", "paused", "stalled"].includes(job.status)));
        if (paused) pausedCount++;
        const running = orderedJobs.some((job) => job.status === "running") || value.intents.some((intent) => intent.batchId && intent.status === "running");
        const queued = orderedJobs.some((job) => job.status === "queued" || (job.status === "stalled" && job.retryAt)) || Boolean(pendingIntent);
        const status: ActivityStory["status"] = questions.some((item) => item.presentation.credentialRequest) ? "waiting" : decisions.length ? "needs_attention"
            : paused ? "paused" : running ? "working" : queued ? settings.autonomy === "observe" ? "observing" : "queued" : latestJob?.status === "cancelled" || latestJob?.status === "stalled" ? "stopped"
            : latestJob?.status === "completed" || value.items.some((item) => ["approved", "answered", "dismissed"].includes(item.status)) || value.intents.some((intent) => intent.status === "completed") ? "completed" : "observing";
        const signalsByTime = value.signals.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const noticed = signalsByTime[0];
        const latestItem = value.items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
        const currentSpec = specs.find((spec) => spec.id === subject.id);
        const failureRunId = string(noticed?.payload.runId) ?? latestJob?.runId;
        const failureRun = failureRunId ? await runsRepository.getRun(failureRunId) : null;
        const failureReason = failureRun && specs.some((spec) => spec.id === failureRun.specId) && failureRun.failReason
            ? plainReason(await clean(failureRun.failReason)) : undefined;
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
        const noticedText: Record<string, string> = {
            invalid_spec: "The current Spec could not run.", spec_failure: "A test run did not complete as expected.", spec_changed: "The Spec was edited.",
            deployment: "A new deployment was reported.", deployment_changed: "An application update was detected.",
        };
        const summary = decisions[0]?.presentation.summary ?? failureReason ?? (noticed ? noticedText[noticed.kind] : undefined) ?? "";
        const timeline: ActivityStory["timeline"] = [];
        const noticedDetail = noticed?.kind === "invalid_spec" ? plainReason(await clean(invalidReason)) : noticed ? noticedText[noticed.kind] : undefined;
        if (noticed && noticedDetail && noticedDetail !== summary) timeline.push({ id: noticed.id, label: "Noticed", detail: noticedDetail, createdAt: noticed.createdAt });
        for (const item of value.items) {
            const verification = item.payload.verification as ProposalVerification | undefined;
            if (!verification) continue;
            const verifiedAction = actions.get(item.jobId)?.find((action) => action.action === "proposal:verified" && action.detail?.startsWith(`${item.id}:`));
            if (verifiedAction) timeline.push({ id: `${item.id}:test`, label: "Tested update", detail: item.presentation.workDone, createdAt: verifiedAction.createdAt });
        }
        if (latestItem) timeline.push({ id: latestItem.id, label: awaiting(latestItem) ? latestItem.kind === "bug_report" ? "Problem found" : "Your decision" : latestItem.status === "approved" ? "Saved" : latestItem.status === "answered" ? "Answered" : "Reviewed",
            detail: awaiting(latestItem) ? latestItem.presentation.title : latestItem.status === "approved" ? `Saved the approved change to “${subject.name}”.` : latestItem.status === "answered" ? `Received your answer about “${subject.name}”.` : `Set aside the suggestion for “${subject.name}”.`, createdAt: latestItem.updatedAt });
        else if (paused && latestJob) timeline.push({ id: `${latestJob.id}:pause`, label: "Paused by you", detail: globallyPaused ? "Specbook is paused across all projects." : "Specbook is paused for this project.", createdAt: settings.updatedAt });
        timeline.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
        const times = [...value.signals.map((signal) => signal.createdAt), ...value.jobs.flatMap((job) => [job.createdAt, job.updatedAt]), ...value.intents.flatMap((intent) => [intent.createdAt, intent.updatedAt]), ...value.items.map((item) => item.updatedAt)].sort();
        const technicalDetails = await clean(value.jobs.map((job) => (actions.get(job.id) ?? []).map((action) => `${action.action}${action.detail ? `: ${action.detail}` : ""}`).join("\n")).filter(Boolean).join("\n\n"));
        activity.push({ id, subject, title, status, nextStep, createdAt: times[0] ?? project.createdAt, updatedAt: times.at(-1) ?? project.createdAt,
            summary,
            timeline, jobIds: orderedJobs.map((job) => job.id), inboxIds: value.items.map((item) => item.id), specId: subject.type === "spec" ? subject.id : undefined,
            runId: latestJob?.runId ?? undefined, technicalDetails });
    }
    activity.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const attentionCount = items.filter((item) => awaiting(item) && item.kind !== "bug_report").length;
    const activeCount = activity.filter((story) => story.status === "working").length;
    const queuedCount = activity.filter((story) => story.status === "queued").length;
    const lastCheckedAt = [...jobs.map((job) => job.updatedAt), ...signals.map((signal) => signal.createdAt)].sort().at(-1) ?? null;
    const unhealthy = jobs.find((job) => infrastructureJobs.has(job.id));
    const systemHealth = unhealthy ? { message: "Specbook is recovering from a service problem. Runs will resume automatically.", detail: "Your application and its Specs have not been changed. You do not need to approve a fix for this." } : undefined;
    const statusText = agentPaused ? globallyPaused ? "Specbook is paused by you across all projects." : `Specbook is paused by you for ${project.name}.`
        : `Specbook is ${activeCount > 0 ? "working on" : "watching"} ${project.name}.`;
    return { items, activity, summary: { projectName: project.name, statusText, attentionCount, activeCount, queuedCount, pausedCount, lastCheckedAt, paused: settings.paused, globallyPaused, systemHealth, autonomy: settings.autonomy } };
}
