"use client";

import { useAuth } from "@/components/AuthProvider";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, ExternalLink, FileCode2, FileX2, Images, Info, PencilLine, Play, RefreshCw, RotateCcw, Target, TriangleAlert, Video } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { EnvironmentSelect } from "@/components/EnvironmentSelect";
import { PageContainer, PageHeader, type Crumb } from "@/components/PageHeader";
import { RawFileEditor } from "@/components/RawFileEditor";
import { RelativeTime } from "@/components/RelativeTime";
import { RunDiagnostics } from "@/components/RunDiagnostics";
import { SectionHeader } from "@/components/SectionHeader";
import { SpecHistoryDialog } from "@/components/SpecHistoryDialog";
import { ApiRunEvidence } from "@/components/SpecRunDialog";
import { StatusPill } from "@/components/StatusPill";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { API_URL, ApiError, errorMessage, getRunArtifactText, getRunEvidence, getSpec, isAbortError, runSpec, setSpecLifecycle, updateSpec, updateSpecFiles } from "@/lib/api";
import { formatDateTime, formatDuration } from "@/lib/format";
import { statusMeta } from "@/lib/status";
import { cn } from "@/lib/utils";
import type { HumanSpec, Run, RunEvidence, SpecDetail } from "@/lib/types";

function splitLines(raw: string): string[] {
    return raw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
}

interface LoadedRunEvidence {
    data: RunEvidence | null;
    error: string;
    /** True when the run's spec.ts read saved credentials, so no HTML report was kept. */
    usedSecrets?: boolean;
}

/** Splits "Line L, column C: message" (spec.ts validation) into its location and message. */
function parseSourceLocation(reason: string): { line: number; column: number; message: string } | null {
    const match = /^Line (\d+), column (\d+): ([\s\S]*)$/.exec(reason);
    if (!match) return null;
    return { line: Number(match[1]), column: Number(match[2]), message: match[3] };
}

type EvidenceSelection = { runId: string; step: RunEvidence["steps"][number] };

function artifactUrl(runId: string, file: string) {
    const path = file.split("/").map(encodeURIComponent).join("/");
    return `${API_URL}/runs/${encodeURIComponent(runId)}/artifacts/${path}`;
}

/** Most recent runs requested with the Spec; older history is not needed on this page. */
const RUN_HISTORY_LIMIT = 20;

async function loadRunEvidence(runId: string, signal?: AbortSignal): Promise<LoadedRunEvidence> {
    try {
        const data = await getRunEvidence(runId, signal);
        let usedSecrets = false;
        if (!data.reportUrl) {
            const source = await getRunArtifactText(runId, "spec.ts", signal);
            usedSecrets = source !== null && /\bsecret\s*\(/.test(source);
        }
        return { data, error: "", usedSecrets };
    } catch (error) {
        if (isAbortError(error)) throw error;
        return { data: null, error: errorMessage(error) };
    }
}

function Dot() {
    return <span aria-hidden="true" className="text-ink-disabled">·</span>;
}

/* ------------------------------------------------------------------ status banner */

function FailureReason({ reason, tone = "danger" }: { reason: string; tone?: "danger" | "invalid" }) {
    return (
        <pre className={cn("mt-3 max-h-48 overflow-auto rounded-lg px-3 py-2.5 font-mono text-meta whitespace-pre-wrap break-words", tone === "invalid" ? "bg-invalid-soft text-invalid" : "bg-danger-soft text-danger")}>
            {reason}
        </pre>
    );
}

function SourceExcerpt({ source, line }: { source: string; line: number }) {
    const lines = source.split("\n");
    if (line < 1 || line > lines.length) return null;
    const first = Math.max(1, line - 1);
    const last = Math.min(lines.length, line + 1);
    const width = String(last).length;
    return (
        <pre aria-label={`spec.ts around line ${line}`} className="mt-2 overflow-x-auto rounded-md border border-line bg-code-canvas py-1.5 font-mono text-meta leading-5 text-ink">
            <span className="block w-max min-w-full">
            {lines.slice(first - 1, last).map((text, index) => {
                const number = first + index;
                const current = number === line;
                return (
                    <span key={number} className={cn("block px-2.5", current && "bg-invalid-soft")}>
                        <span aria-hidden="true" className={cn("mr-3 inline-block text-right tabular select-none", current ? "text-invalid" : "text-ink-subtle")} style={{ width: `${width}ch` }}>{number}</span>
                        {text || " "}
                    </span>
                );
            })}
            </span>
        </pre>
    );
}

function InvalidReason({ reason, testSource }: { reason: string; testSource: string | null }) {
    const location = parseSourceLocation(reason);
    if (!location) return <FailureReason tone="invalid" reason={reason} />;
    return (
        <div className="mt-3 rounded-lg bg-invalid-soft px-3 py-2.5">
            <p className="font-mono text-meta font-medium text-invalid">spec.ts · line {location.line}, column {location.column}</p>
            <p className="mt-1 font-mono text-meta whitespace-pre-wrap break-words text-invalid">{location.message}</p>
            {testSource && <SourceExcerpt source={testSource} line={location.line} />}
        </div>
    );
}

function VerificationBanner({
    projectId,
    detail: specDetail,
    spec,
    latestRun,
    latestEvidence,
    running,
    environment,
}: {
    projectId: string;
    detail: SpecDetail;
    spec: SpecDetail["spec"];
    latestRun: Run | undefined;
    latestEvidence: LoadedRunEvidence | undefined;
    running: boolean;
    environment: string;
}) {
    const { canEdit } = useAuth();
    let status: string;
    let headline: string;
    let detail: React.ReactNode = null;
    let body: React.ReactNode = null;

    if (running) {
        status = "running";
        headline = "Verifying now";
        detail = `Running this Spec against ${environment}. Results appear here when it finishes.`;
    } else if (spec.status === "invalid") {
        status = "invalid";
        headline = "This Spec can't run";
        detail = "Its saved steps or executable source need attention. Ask the agent to repair it, then verify the result.";
        body = (
            <>
                <InvalidReason reason={spec.invalidReason ?? "The spec.yml or spec.ts file could not be validated."} testSource={specDetail.content?.testSource ?? null} />
                {canEdit && <div className="mt-3 flex flex-wrap gap-2">
                    <Button asChild size="sm" variant="outline">
                        <Link href={`/p/${projectId}/chats/new?specId=${encodeURIComponent(spec.id)}&intent=repair`}><PencilLine size={13} /> Repair in chat</Link>
                    </Button>
                </div>}
            </>
        );
    } else if (!latestRun) {
        status = "unverified";
        headline = "Not verified yet";
        detail = "Run this Spec to verify the behavior against the app.";
    } else if (spec.status === "unverified") {
        status = "unverified";
        headline = "Not verified since the last change";
        detail = <>Last run {statusMeta(latestRun.status).runLabel.toLowerCase()} <RelativeTime value={latestRun.startedAt} />. Run it again to confirm the current version.</>;
    } else {
        status = latestRun.status;
        const passed = latestRun.status === "passed";
        headline = passed ? "Last run passed" : latestRun.status === "error" ? "Last run could not complete" : "Last run failed";
        const steps = latestEvidence?.data?.steps ?? [];
        const failedStep = passed ? null : latestEvidence?.data?.failedStep ?? null;
        const lastStep = !passed && !failedStep && steps.length > 0 ? steps[steps.length - 1] : null;
        detail = (
            <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                <RelativeTime value={latestRun.startedAt} />
                <Dot /><span title={latestRun.baseUrl ?? undefined}>{latestRun.environment?.name ?? "Production"}</span>
                {latestRun.durationMs !== null && <><Dot /><span className="tabular">took {formatDuration(latestRun.durationMs)}</span></>}
                {failedStep && <><Dot /><span>stopped at “{failedStep}”</span></>}
                {lastStep && <><Dot /><span>last captured step {lastStep.number}: {lastStep.label}</span></>}
            </span>
        );
        if (!passed && latestRun.failReason) body = <FailureReason reason={latestRun.failReason} />;
    }

    const meta = statusMeta(status);
    const Icon = meta.icon;
    return (
        <section aria-label="Run status" role={status === "failed" || status === "invalid" || status === "error" ? "alert" : "status"} className="flex gap-3.5 rounded-xl border border-line bg-surface p-4">
            <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-full", meta.soft, meta.text)}>
                <Icon size={17} strokeWidth={2.25} aria-hidden="true" className={status === "running" ? "animate-spin motion-reduce:animate-none" : undefined} />
            </span>
            <div className="min-w-0 flex-1">
                <p className="pt-0.5 text-body font-semibold text-ink">{headline}</p>
                {detail && <div className="mt-0.5 text-control text-ink-muted">{detail}</div>}
                {body}
            </div>
        </section>
    );
}

/* ------------------------------------------------------------------ specification */

function BulletList({ items, empty }: { items: string[]; empty: string }) {
    if (items.length === 0) return <p className="mt-2 text-body text-ink-subtle">{empty}</p>;
    return (
        <ul className="mt-2 space-y-1.5">
            {items.map((item, index) => (
                <li key={`${index}-${item}`} className="flex gap-3 text-body text-ink">
                    <span aria-hidden="true" className="mt-[0.6rem] size-1.5 shrink-0 rounded-full bg-ink-subtle/60" />
                    <span className="min-w-0">{item}</span>
                </li>
            ))}
        </ul>
    );
}

function SpecSection({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
    return (
        <section>
            <h3 className="flex items-baseline gap-2 text-control font-semibold text-ink">
                {title}
                {count !== undefined && count > 0 && <span className="tabular font-normal text-ink-subtle">{count}</span>}
            </h3>
            {children}
        </section>
    );
}

function SpecificationView({ humanSpec }: { humanSpec: HumanSpec }) {
    return (
        <div className="space-y-7">
            <SpecSection title="Preconditions" count={humanSpec.preconditions.length}>
                <BulletList items={humanSpec.preconditions} empty="No preconditions recorded." />
            </SpecSection>

            <SpecSection title="Steps" count={humanSpec.steps.length}>
                {humanSpec.steps.length === 0 ? (
                    <p className="mt-2 text-body text-ink-subtle">No steps recorded.</p>
                ) : (
                    <ol className="mt-3">
                        {humanSpec.steps.map((step, index) => (
                            <li key={`${index}-${step}`} className="relative flex gap-3.5 pb-4 last:pb-0">
                                {index < humanSpec.steps.length - 1 && <span aria-hidden="true" className="absolute top-7 bottom-1 left-3 w-px bg-line" />}
                                <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-full border border-line-strong bg-surface text-meta font-semibold text-ink-muted tabular">{index + 1}</span>
                                <span className="min-w-0 pt-0.5 text-body text-ink"><span className="sr-only">Step {index + 1}: </span>{step}</span>
                            </li>
                        ))}
                    </ol>
                )}
            </SpecSection>

            <section aria-labelledby="expected-result-heading" className="relative overflow-hidden rounded-xl border border-line bg-surface-soft py-3.5 pr-4 pl-5">
                <span aria-hidden="true" className="absolute inset-y-0 left-0 w-1 bg-primary" />
                <h3 id="expected-result-heading" className="flex items-center gap-1.5 text-control font-semibold text-ink">
                    <Target size={14} aria-hidden="true" className="text-ink-muted" /> Expected result
                </h3>
                <p className={cn("mt-1.5 text-body", humanSpec.expectedResult ? "font-medium text-ink" : "text-ink-subtle")}>{humanSpec.expectedResult || "No expected result recorded."}</p>
            </section>

            <SpecSection title="Postconditions" count={humanSpec.postconditions.length}>
                <BulletList items={humanSpec.postconditions} empty="No postconditions recorded." />
            </SpecSection>
        </div>
    );
}

/* ------------------------------------------------------------------ verification history */

function EvidenceGallery({ runId, evidence, onSelect }: { runId: string; evidence: RunEvidence; onSelect: (step: RunEvidence["steps"][number]) => void }) {
    if (evidence.steps.length === 0) return null;
    return (
        <section aria-labelledby={`evidence-${runId}`}>
            <h4 id={`evidence-${runId}`} className="flex items-center gap-1.5 text-meta font-semibold text-ink-muted"><Images size={13} aria-hidden="true" /> Screenshots by step</h4>
            <ScrollArea orientation="horizontal" className="mt-2 w-full pb-2.5">
                <div className="flex w-max gap-2.5">
                    {evidence.steps.map((step) => (
                        <button
                            key={step.file}
                            type="button"
                            onClick={() => onSelect(step)}
                            className="group/shot flex w-48 flex-col overflow-hidden rounded-lg border border-line bg-surface text-left outline-none transition-colors hover:border-line-hover focus-visible:ring-2 focus-visible:ring-ring sm:w-52"
                        >
                            <img src={artifactUrl(runId, step.file)} alt="" loading="lazy" className="h-28 w-full border-b border-line bg-surface-soft object-cover object-top" />
                            <span className="px-2.5 pt-2 text-meta font-medium text-ink-subtle tabular">Step {step.number}</span>
                            <span className="line-clamp-2 min-h-10 px-2.5 pt-0.5 pb-2 text-meta leading-5 break-words text-ink">{step.label}</span>
                        </button>
                    ))}
                </div>
            </ScrollArea>
        </section>
    );
}

function RunEvidencePanel({ run, loaded, onSelect }: { run: Run; loaded: LoadedRunEvidence | undefined; onSelect: (selection: EvidenceSelection) => void }) {
    const evidence = loaded?.data;
    if (run.status === "running") return <p role="status" className="text-body text-ink-muted">This run is in progress. Evidence appears when it finishes.</p>;
    if (!loaded) return <Skeleton className="h-24 w-full rounded-lg" aria-label="Loading evidence" />;
    if (loaded.error) return <Alert variant="danger" role="alert"><AlertDescription>Could not load evidence: {loaded.error}</AlertDescription></Alert>;
    if (!evidence) return null;
    const empty = evidence.steps.length === 0 && !evidence.apiSteps?.length && !evidence.video && !evidence.diagnostics?.length && !evidence.errorContext && !(run.status === "passed" && evidence.expectedResult);
    return (
        <div className="space-y-4">
            {run.status === "passed" && evidence.expectedResult && (
                <p className="flex items-start gap-2 text-control text-ink-muted">
                    <Check size={14} strokeWidth={2.25} aria-hidden="true" className="mt-0.5 shrink-0 text-success" />
                    <span><span className="font-medium text-ink">Expected result confirmed.</span> {evidence.expectedResult}</span>
                </p>
            )}
            {evidence.video && run.status !== "passed" && (
                <section aria-labelledby={`video-${run.id}`}>
                    <h4 id={`video-${run.id}`} className="flex items-center gap-1.5 text-meta font-semibold text-ink-muted"><Video size={13} aria-hidden="true" /> Recording</h4>
                    <video controls preload="metadata" className="mt-2 aspect-video w-full rounded-lg border border-line bg-browser" src={artifactUrl(run.id, evidence.video)} />
                </section>
            )}
            <EvidenceGallery runId={run.id} evidence={evidence} onSelect={(step) => onSelect({ runId: run.id, step })} />
            <ApiRunEvidence evidence={evidence} />
            <RunDiagnostics evidence={evidence} />
            {empty && <p className="text-control text-ink-subtle">No evidence was recorded for this run.</p>}
            {!evidence.reportUrl && loaded.usedSecrets && (
                <p className="flex items-start gap-2 text-meta text-ink-subtle">
                    <Info size={13} aria-hidden="true" className="mt-0.5 shrink-0" />
                    Report not kept because this run used saved credentials.
                </p>
            )}
        </div>
    );
}

function RunEntry({
    run,
    latest,
    last,
    loaded,
    onExpand,
    onSelect,
}: {
    run: Run;
    latest: boolean;
    last: boolean;
    loaded: LoadedRunEvidence | undefined;
    onExpand: (runId: string) => void;
    onSelect: (selection: EvidenceSelection) => void;
}) {
    const [open, setOpen] = useState(latest);
    const meta = statusMeta(run.status);
    // Evidence loads lazily: the latest run is requested with the Spec, older runs when expanded.
    // This also re-requests it when the evidence cache was reset while the entry stayed open.
    useEffect(() => {
        if (open && !loaded && run.status !== "running") onExpand(run.id);
    }, [loaded, onExpand, open, run.id, run.status]);
    const reportUrl = loaded?.data?.reportUrl;
    return (
        <li id={`run-${run.id}`} className="relative scroll-mt-4 pb-6 pl-8 last:pb-0">
            {!last && <span aria-hidden="true" className="absolute top-5 bottom-0 left-[0.6875rem] w-px bg-line" />}
            <span aria-hidden="true" className={cn("absolute top-1.5 left-1.5 size-3 rounded-full ring-4 ring-surface", meta.chart)} />
            <Collapsible
                open={open}
                onOpenChange={(next) => {
                    setOpen(next);
                    if (next && run.status !== "running") onExpand(run.id);
                }}
            >
                <div className="flex min-h-7 flex-wrap items-center gap-x-2.5 gap-y-1">
                    <StatusPill status={run.status} kind="run" size="sm" />
                    {run.flaky && <Badge variant="warning" size="sm" title="Failed first, then passed on an automatic retry with no test changes."><RotateCcw size={12} aria-hidden="true" /> Flaky</Badge>}
                    <span className="flex flex-wrap items-center gap-x-1.5 text-meta text-ink-muted">
                        <span title={formatDateTime(run.startedAt)}><RelativeTime value={run.startedAt} /></span>
                        <Dot /><span title={run.baseUrl ?? undefined}>{run.environment?.name ?? "Production"}</span>
                        {run.durationMs !== null && <><Dot /><span className="tabular">{formatDuration(run.durationMs)}</span></>}
                        {run.commitSha && <><Dot /><span className="font-mono" title="Commit">{run.commitSha.slice(0, 7)}</span></>}
                    </span>
                    <span className="ml-auto flex items-center gap-1">
                        {reportUrl && (
                            <Button asChild variant="ghost" size="sm" className="h-7 px-2">
                                <a href={`${API_URL}${reportUrl}`} target="_blank" rel="noreferrer">View report <ExternalLink size={12} aria-hidden="true" /></a>
                            </Button>
                        )}
                        <CollapsibleTrigger asChild>
                            <Button type="button" variant="ghost" size="sm" className="group/toggle h-7 px-2" aria-label={`${open ? "Hide" : "Show"} evidence for the run ${formatDateTime(run.startedAt)}`}>
                                Evidence <ChevronDown size={13} aria-hidden="true" className="transition-transform group-data-[state=open]/toggle:rotate-180 motion-reduce:transition-none" />
                            </Button>
                        </CollapsibleTrigger>
                    </span>
                </div>
                {run.retryOf && (
                    <p className="mt-2 text-meta text-ink-muted">
                        {run.flaky ? "Passed on the automatic retry. " : "Automatic retry. "}
                        <a href={`#run-${run.retryOf}`} className="rounded-sm font-medium underline underline-offset-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">View first attempt</a>
                    </p>
                )}
                {run.status !== "passed" && loaded?.data?.failedStep && (
                    <p className="mt-2 text-control text-ink-muted"><span className="font-medium text-ink">Failed at step:</span> {loaded.data.failedStep}</p>
                )}
                {run.status !== "passed" && run.failReason && <FailureReason reason={run.failReason} />}
                <CollapsibleContent className="pt-3">
                    <RunEvidencePanel run={run} loaded={loaded} onSelect={onSelect} />
                </CollapsibleContent>
            </Collapsible>
        </li>
    );
}

/* ------------------------------------------------------------------ edit form */

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
    return (
        <div className="space-y-1.5">
            <Label htmlFor={id}>{label}</Label>
            {children}
            {hint && <p id={`${id}-hint`} className="text-meta text-ink-subtle">{hint}</p>}
        </div>
    );
}

export default function SpecPage({ params }: { params: Promise<{ projectId: string; specId: string }> }) {
    const { canEdit } = useAuth();
    const { projectId, specId } = use(params);
    const router = useRouter();
    const [detail, setDetail] = useState<SpecDetail | null>(null);
    const [evidence, setEvidence] = useState<Record<string, LoadedRunEvidence>>({});
    const [selectedEvidence, setSelectedEvidence] = useState<{ runId: string; step: RunEvidence["steps"][number] } | null>(null);
    const [loadError, setLoadError] = useState("");
    const [actionError, setActionError] = useState("");
    const [runRefreshError, setRunRefreshError] = useState("");
    const [running, setRunning] = useState(false);
    const [environment, setEnvironment] = useState("Production");
    const [changingLifecycle, setChangingLifecycle] = useState(false);
    const [retryKey, setRetryKey] = useState(0);
    const [editing, setEditing] = useState(false);
    const [titleDraft, setTitleDraft] = useState("");
    const [descriptionDraft, setDescriptionDraft] = useState("");
    const [preconditionsDraft, setPreconditionsDraft] = useState("");
    const [stepsDraft, setStepsDraft] = useState("");
    const [expectedResultDraft, setExpectedResultDraft] = useState("");
    const [postconditionsDraft, setPostconditionsDraft] = useState("");
    const [rawYamlDraft, setRawYamlDraft] = useState("");
    const [testSourceDraft, setTestSourceDraft] = useState("");
    const [sourceOpen, setSourceOpen] = useState(false);
    const [savedInvalid, setSavedInvalid] = useState(false);
    const bannerRef = useRef<HTMLDivElement>(null);
    const [saving, setSaving] = useState(false);

    const evidenceRequestsRef = useRef(new Set<string>());

    const ensureEvidence = useCallback((runId: string) => {
        if (evidenceRequestsRef.current.has(runId)) return;
        evidenceRequestsRef.current.add(runId);
        void loadRunEvidence(runId).then((loaded) => {
            setEvidence((current) => ({ ...current, [runId]: loaded }));
            // A failed load can be retried by collapsing and expanding the run again.
            if (loaded.error) evidenceRequestsRef.current.delete(runId);
        }).catch(() => evidenceRequestsRef.current.delete(runId));
    }, []);

    /** Replaces the detail and loads evidence only for the latest run; older runs load on expand. */
    const showDetail = useCallback((nextDetail: SpecDetail) => {
        evidenceRequestsRef.current = new Set();
        setEvidence({});
        setDetail(nextDetail);
        if (nextDetail.runs[0] && nextDetail.runs[0].status !== "running") ensureEvidence(nextDetail.runs[0].id);
    }, [ensureEvidence]);

    useEffect(() => {
        const controller = new AbortController();
        setDetail(null);
        setEvidence({});
        setLoadError("");
        async function load() {
            try {
                const nextDetail = await getSpec(specId, { limit: RUN_HISTORY_LIMIT, signal: controller.signal });
                if (nextDetail.spec.projectId !== projectId) throw new Error("This Spec does not belong to this project.");
                if (controller.signal.aborted) return;
                showDetail(nextDetail);
            } catch (error) {
                if (!controller.signal.aborted && !isAbortError(error)) setLoadError(errorMessage(error));
            }
        }
        void load();
        return () => controller.abort();
    }, [projectId, retryKey, showDetail, specId]);

    const pendingRun = Boolean(detail?.runs.some((run) => run.status === "running" || run.automationPending));
    useEffect(() => {
        if (!pendingRun) return;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout>;
        async function refreshRun() {
            try {
                const nextDetail = await getSpec(specId, { limit: RUN_HISTORY_LIMIT, signal: controller.signal });
                if (nextDetail.spec.projectId !== projectId) throw new Error("This Spec does not belong to this project.");
                setDetail(nextDetail);
                setRunRefreshError("");
            } catch (error) {
                if (!isAbortError(error)) setRunRefreshError(errorMessage(error));
            } finally {
                if (!controller.signal.aborted) timer = setTimeout(() => void refreshRun(), 1500);
            }
        }
        timer = setTimeout(() => void refreshRun(), 1500);
        return () => {
            controller.abort();
            clearTimeout(timer);
        };
    }, [pendingRun, projectId, specId]);

    /** Reloads the Spec after an action; returns null when it no longer exists. */
    async function reloadDetail(): Promise<SpecDetail | null> {
        try {
            const nextDetail = await getSpec(specId, { limit: RUN_HISTORY_LIMIT });
            if (nextDetail.spec.projectId !== projectId) throw new Error("This Spec does not belong to this project.");
            return nextDetail;
        } catch (error) {
            if (error instanceof ApiError && error.status === 404) {
                router.replace(`/p/${projectId}/specs`);
                return null;
            }
            throw error;
        }
    }

    const selectedSteps = selectedEvidence ? evidence[selectedEvidence.runId]?.data?.steps ?? [] : [];
    const selectedIndex = selectedEvidence
        ? selectedSteps.findIndex((step) => step.file === selectedEvidence.step.file)
        : -1;
    const hasPrev = selectedIndex > 0;
    const hasNext = selectedIndex >= 0 && selectedIndex < selectedSteps.length - 1;

    const stepBy = useCallback(
        (delta: number) => {
            if (!selectedEvidence || selectedIndex < 0) return;
            const nextStep = selectedSteps[selectedIndex + delta];
            if (nextStep) setSelectedEvidence({ runId: selectedEvidence.runId, step: nextStep });
        },
        [selectedEvidence, selectedIndex, selectedSteps],
    );

    useEffect(() => {
        if (!selectedEvidence) return;
        function handleKeyDown(event: KeyboardEvent) {
            if (event.key === "ArrowLeft") stepBy(-1);
            if (event.key === "ArrowRight") stepBy(1);
        }
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [selectedEvidence, stepBy]);

    async function runNow() {
        setRunning(true);
        setActionError("");
        try {
            await runSpec(specId, environment);
            const nextDetail = await reloadDetail();
            if (nextDetail) showDetail(nextDetail);
        } catch (error) {
            setActionError(errorMessage(error));
        } finally {
            setRunning(false);
        }
    }

    async function changeLifecycle(lifecycle: "draft" | "active") {
        setChangingLifecycle(true);
        setActionError("");
        try {
            await setSpecLifecycle(specId, lifecycle);
            const nextDetail = await reloadDetail();
            if (nextDetail) showDetail(nextDetail);
        } catch (error) { setActionError(errorMessage(error)); }
        finally { setChangingLifecycle(false); }
    }

    function startEditing() {
        if (!detail?.content) return;
        const { humanSpec } = detail.content;
        setTitleDraft(detail.spec.title);
        setDescriptionDraft(detail.spec.description);
        setPreconditionsDraft(humanSpec ? humanSpec.preconditions.join("\n") : "");
        setStepsDraft(humanSpec ? humanSpec.steps.join("\n") : "");
        setExpectedResultDraft(humanSpec ? humanSpec.expectedResult : "");
        setPostconditionsDraft(humanSpec ? humanSpec.postconditions.join("\n") : "");
        setRawYamlDraft(detail.content.yamlSource);
        setTestSourceDraft(detail.content.testSource);
        setSourceOpen(false);
        setEditing(true);
        setActionError("");
        setSavedInvalid(false);
    }

    async function saveFiles() {
        if (!detail?.content) return;
        setSaving(true);
        setActionError("");
        try {
            let current = detail;
            if (current.content?.humanSpec) {
                const patch: { title?: string; description?: string; humanSpec?: typeof current.content.humanSpec } = {};
                if (titleDraft.trim() !== current.spec.title) patch.title = titleDraft.trim();
                if (descriptionDraft !== current.spec.description) patch.description = descriptionDraft;
                const nextHumanSpec = {
                    preconditions: splitLines(preconditionsDraft),
                    steps: splitLines(stepsDraft),
                    expectedResult: expectedResultDraft.trim(),
                    postconditions: splitLines(postconditionsDraft),
                };
                if (JSON.stringify(nextHumanSpec) !== JSON.stringify(current.content.humanSpec)) patch.humanSpec = nextHumanSpec;
                if (Object.keys(patch).length > 0) current = await updateSpec(specId, patch);
            } else if (rawYamlDraft !== current.content?.yamlSource) {
                current = await updateSpecFiles(specId, { yaml: rawYamlDraft });
            }
            if (current.content && testSourceDraft !== current.content.testSource) {
                current = await updateSpecFiles(specId, { testSource: testSourceDraft });
            }
            setDetail(current);
            setEditing(false);
            const nowInvalid = current.spec.status === "invalid";
            setSavedInvalid(nowInvalid);
            if (nowInvalid) requestAnimationFrame(() => bannerRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }));
        } catch (error) {
            setActionError(error instanceof Error ? error.message : String(error));
        } finally {
            setSaving(false);
        }
    }

    const specsCrumb: Crumb = { label: "Specs", href: `/p/${projectId}/specs` };

    if (loadError && !detail) {
        return (
            <div className="flex min-h-full flex-col bg-surface">
                <PageHeader title="Spec" breadcrumbs={[specsCrumb]} width="reading" />
                <EmptyState
                    role="alert"
                    tone="danger"
                    icon={FileX2}
                    title="This Spec could not load"
                    description={loadError}
                    action={<Button type="button" onClick={() => setRetryKey((key) => key + 1)}><RefreshCw size={14} /> Try again</Button>}
                />
            </div>
        );
    }

    if (!detail) {
        return (
            <div className="min-h-full bg-surface" aria-label="Loading Spec" aria-busy="true" role="status">
                <PageHeader title={<Skeleton className="h-6 w-72 max-w-full" />} breadcrumbs={[specsCrumb]} width="reading" />
                <PageContainer width="reading" innerClassName="space-y-8">
                    <Skeleton className="h-[4.5rem] rounded-xl" />
                    <div className="space-y-3"><Skeleton className="h-4 w-28" /><Skeleton className="h-4 w-2/3" /><Skeleton className="h-4 w-1/2" /></div>
                    <div className="space-y-3"><Skeleton className="h-4 w-20" />{Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-5 w-3/4" />)}</div>
                    <Skeleton className="h-20 rounded-xl" />
                </PageContainer>
            </div>
        );
    }

    const { spec, feature, content, runs } = detail;
    const latestRun = runs[0];
    const crumbs: Crumb[] = [specsCrumb, ...(feature ? [{ label: feature.title, href: `/p/${projectId}/features/${feature.id}` }] : [])];
    const sourceEdited = Boolean(content && testSourceDraft !== content.testSource);
    const stepsChanged = Boolean(editing && content?.humanSpec && JSON.stringify(splitLines(stepsDraft)) !== JSON.stringify(content.humanSpec.steps));

    return (
        <div className="min-h-full bg-surface">
            <PageHeader
                title={spec.title}
                breadcrumbs={crumbs}
                width="reading"
                titleAdornment={<><Badge variant="neutral">{spec.lifecycle === "draft" ? "Draft" : "Active"}</Badge>{latestRun?.flaky && <Badge variant="warning"><RotateCcw size={12} aria-hidden="true" /> Flaky</Badge>}</>}
                description={spec.description || undefined}
                actions={
                    <>
                        <SpecHistoryDialog specId={specId} />
                        {canEdit && <><Button type="button" variant="outline" size="sm" onClick={() => void changeLifecycle(spec.lifecycle === "draft" ? "active" : "draft")} disabled={changingLifecycle || running || saving || (spec.lifecycle === "draft" && spec.status === "invalid")}>{changingLifecycle ? "Saving..." : spec.lifecycle === "draft" ? "Activate" : "Make draft"}</Button>
                        <Button type="button" variant="outline" size="sm" onClick={editing ? () => setEditing(false) : startEditing} disabled={!content || saving}>
                            <PencilLine size={13} /> {editing ? "Cancel editing" : "Edit"}
                        </Button>
                        <EnvironmentSelect projectId={projectId} value={environment} onValueChange={setEnvironment} disabled={running} />
                        <Button type="button" size="sm" onClick={runNow} disabled={running || !content || spec.status === "invalid"}>
                            <Play size={12} fill="currentColor" /> {running ? "Running…" : "Run"}
                        </Button></>}
                    </>
                }
            />
            <PageContainer width="reading" className="min-w-0 [overflow-wrap:anywhere] lg:pb-14" innerClassName="space-y-9">
                {actionError && <Alert variant="danger" role="alert"><AlertDescription>{actionError}{/pending file edits/.test(actionError) && <Link href={`/p/${projectId}/settings?tab=git`} className="mt-2 block font-medium underline underline-offset-2">Review pending edits</Link>}</AlertDescription></Alert>}
                {runRefreshError && <Alert variant="warning" role="status"><AlertDescription>Run updates are delayed: {runRefreshError} Retrying…</AlertDescription></Alert>}
                {spec.lifecycle === "draft" && <p className="text-control text-ink-muted">This draft can be run manually. Activate it when you trust the result to include it in scheduled runs and CI.</p>}

                <div ref={bannerRef} className="scroll-mt-4 space-y-3">
                {savedInvalid && spec.status === "invalid" && (
                    <Alert variant="warning" role="alert">
                        <AlertDescription>Your changes were saved, but the Spec is now invalid and can&apos;t run. The reason is shown below.</AlertDescription>
                    </Alert>
                )}
                <VerificationBanner
                    projectId={projectId}
                    detail={detail}
                    spec={spec}
                    latestRun={latestRun}
                    latestEvidence={latestRun ? evidence[latestRun.id] : undefined}
                    running={running}
                    environment={environment}
                />
                </div>

                <section aria-labelledby="specification-heading">
                    <SectionHeader id="specification-heading" title={editing ? "Edit specification" : "Specification"} className="mb-4" />
                    {editing && content ? (
                        <form className="space-y-6" onSubmit={(event) => { event.preventDefault(); void saveFiles(); }}>
                            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg border border-line bg-surface-soft px-3.5 py-2.5">
                                <p className="text-control text-ink-muted">Prefer to describe the change instead?</p>
                                <Button asChild variant="outline" size="sm">
                                    <Link href={`/p/${projectId}/chats/new?specId=${encodeURIComponent(spec.id)}`}><PencilLine size={13} /> Edit with AI</Link>
                                </Button>
                            </div>
                            {content.humanSpec ? (
                                <div className="space-y-5">
                                    <Field id="spec-title" label="Title">
                                        <Input id="spec-title" value={titleDraft} onChange={(event) => setTitleDraft(event.target.value)} disabled={saving} aria-invalid={!titleDraft.trim() || undefined} />
                                    </Field>
                                    <Field id="spec-description" label="Description">
                                        <Textarea id="spec-description" value={descriptionDraft} onChange={(event) => setDescriptionDraft(event.target.value)} disabled={saving} rows={2} />
                                    </Field>
                                    <Field id="spec-preconditions" label="Preconditions" hint="One per line. What must be true before the first step.">
                                        <Textarea id="spec-preconditions" aria-describedby="spec-preconditions-hint" value={preconditionsDraft} onChange={(event) => setPreconditionsDraft(event.target.value)} disabled={saving} rows={3} placeholder="A shopper account exists" />
                                    </Field>
                                    <Field id="spec-steps" label="Steps" hint="One per line, in order. Each line becomes a numbered step.">
                                        <Textarea id="spec-steps" aria-describedby={stepsChanged ? "spec-steps-hint spec-steps-note" : "spec-steps-hint"} value={stepsDraft} onChange={(event) => setStepsDraft(event.target.value)} disabled={saving} rows={6} placeholder="Open the store home page" />
                                        {stepsChanged && (
                                            <p id="spec-steps-note" role="status" className="flex items-start gap-2 rounded-md bg-warning-soft px-3 py-2 text-meta text-ink">
                                                <TriangleAlert size={13} aria-hidden="true" className="mt-0.5 shrink-0 text-warning-icon" />
                                                <span>
                                                    {sourceEdited
                                                        ? "Check that the step() titles in the automation source match these steps, in the same order, or the Spec becomes invalid."
                                                        : <>The automation must be updated to match these steps, or the Spec becomes invalid when you save. Use <Link href={`/p/${projectId}/chats/new?specId=${encodeURIComponent(spec.id)}`} className="font-medium underline underline-offset-2">Edit with AI</Link>, or change the step() titles in the automation source below.</>}
                                                </span>
                                            </p>
                                        )}
                                    </Field>
                                    <Field id="spec-expected-result" label="Expected result" hint="The observable outcome that makes this Spec pass.">
                                        <Textarea id="spec-expected-result" aria-describedby="spec-expected-result-hint" value={expectedResultDraft} onChange={(event) => setExpectedResultDraft(event.target.value)} disabled={saving} rows={3} />
                                    </Field>
                                    <Field id="spec-postconditions" label="Postconditions" hint="One per line. What stays true after the run. Optional.">
                                        <Textarea id="spec-postconditions" aria-describedby="spec-postconditions-hint" value={postconditionsDraft} onChange={(event) => setPostconditionsDraft(event.target.value)} disabled={saving} rows={2} />
                                    </Field>
                                </div>
                            ) : (
                                <div className="space-y-3">
                                    <Alert variant="warning" role="alert">
                                        <AlertDescription>The Spec file could not be read as fields. Fix the source below, then save.</AlertDescription>
                                    </Alert>
                                    <RawFileEditor id="spec-yaml" label="spec.yml" language="yaml" value={rawYamlDraft} onChange={setRawYamlDraft} disabled={saving} />
                                </div>
                            )}
                            <Collapsible open={sourceOpen} onOpenChange={setSourceOpen} className="group/source overflow-hidden rounded-xl border border-line">
                                <CollapsibleTrigger asChild>
                                    <button type="button" className="flex w-full items-center gap-3 px-3.5 py-3 text-left outline-none transition-colors hover:bg-surface-soft focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
                                        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-hover text-ink-muted"><FileCode2 size={15} aria-hidden="true" /></span>
                                        <span className="min-w-0 flex-1">
                                            <span className="flex items-center gap-2 text-control font-semibold text-ink">
                                                Advanced: automation source
                                                {sourceEdited && <span className="rounded-full bg-warning-soft px-1.5 text-meta font-medium text-ink">Edited</span>}
                                            </span>
                                            <span className="mt-0.5 block text-meta text-ink-subtle">
                                                {sourceEdited ? "The generated automation will be replaced when you save." : "Generated Playwright test (spec.ts) for this Spec. Most edits only need the fields above."}
                                            </span>
                                        </span>
                                        <ChevronDown size={15} className="shrink-0 text-ink-subtle transition-transform group-data-[state=open]/source:rotate-180 motion-reduce:transition-none" aria-hidden="true" />
                                    </button>
                                </CollapsibleTrigger>
                                <CollapsibleContent className="border-t border-line bg-surface-soft/60 p-3.5">
                                    <RawFileEditor id="spec-test-source" label="spec.ts" language="typescript" value={testSourceDraft} onChange={setTestSourceDraft} disabled={saving} rows={16} />
                                    <p className="mt-2 text-meta text-ink-subtle">Each step(&quot;…&quot;) title must match a step above, in order. Invalid source is still saved, and the Spec is marked for correction.</p>
                                </CollapsibleContent>
                            </Collapsible>
                            <div className="sticky bottom-0 z-10 -mx-4 flex flex-col gap-3 border-t border-line bg-surface/95 px-4 py-3 backdrop-blur-sm sm:mx-0 sm:flex-row sm:items-center sm:justify-between sm:rounded-b-none sm:px-0">
                                <p className="text-meta text-ink-subtle">Saving commits the changes to the repository.</p>
                                <div className="flex flex-col-reverse gap-2 sm:flex-row">
                                    <Button type="button" variant="outline" onClick={() => setEditing(false)} disabled={saving}>Cancel</Button>
                                    <Button type="submit" disabled={saving || (Boolean(content.humanSpec) && !titleDraft.trim())}>{saving ? "Saving…" : "Save changes"}</Button>
                                </div>
                            </div>
                        </form>
                    ) : content && content.humanSpec ? (
                        <SpecificationView humanSpec={content.humanSpec} />
                    ) : content ? (
                        <div className="rounded-xl border border-line">
                            <EmptyState size="compact" tone="warning" icon={FileX2} title="The Spec file could not be read" description="Use Edit to fix the source by hand." />
                        </div>
                    ) : (
                        <div className="rounded-xl border border-line">
                            <EmptyState size="compact" tone="warning" icon={FileX2} title="Spec files unavailable" description="Restore or fix the spec.yml and spec.ts files to continue." />
                        </div>
                    )}
                </section>

                <section aria-labelledby="verification-heading">
                    <SectionHeader
                        id="verification-heading"
                        title="Run history"
                        count={runs.length || undefined}
                        description={runs.length >= RUN_HISTORY_LIMIT ? `Showing the latest ${RUN_HISTORY_LIMIT} runs.` : undefined}
                        className="mb-4"
                    />
                    {runs.length === 0 ? (
                        <p className="rounded-xl border border-dashed border-line-strong px-4 py-5 text-center text-control text-ink-subtle">No runs yet. Screenshots, API responses and recordings from each run appear here.</p>
                    ) : (
                        <ol aria-label="Runs, newest first">
                            {runs.map((run, index) => (
                                <RunEntry
                                    key={run.id}
                                    run={run}
                                    latest={index === 0}
                                    last={index === runs.length - 1}
                                    loaded={evidence[run.id]}
                                    onExpand={ensureEvidence}
                                    onSelect={setSelectedEvidence}
                                />
                            ))}
                        </ol>
                    )}
                </section>
            </PageContainer>
            <Dialog open={selectedEvidence !== null} onOpenChange={(open) => {
                if (!open) setSelectedEvidence(null);
            }}>
                <DialogContent className="max-h-[calc(100dvh-24px)] max-w-[960px] overflow-y-auto p-4 sm:p-5">
                    <DialogHeader>
                        <DialogTitle className="flex items-baseline gap-2">
                            Step {selectedEvidence?.step.number}
                            {selectedSteps.length > 1 && (
                                <span className="text-control font-normal text-ink-subtle tabular">{selectedIndex + 1} of {selectedSteps.length}</span>
                            )}
                        </DialogTitle>
                        <DialogDescription>{selectedEvidence?.step.label}</DialogDescription>
                    </DialogHeader>
                    {selectedEvidence && (
                        <div className="relative mt-4">
                            <img src={artifactUrl(selectedEvidence.runId, selectedEvidence.step.file)} alt={`Evidence for step ${selectedEvidence.step.number}: ${selectedEvidence.step.label}`} className="max-h-[calc(100dvh-150px)] w-full rounded-lg border border-line bg-surface-soft object-contain" />
                            {hasPrev && (
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="icon"
                                    onClick={() => stepBy(-1)}
                                    className="absolute top-1/2 left-2 -translate-y-1/2 rounded-full bg-surface/90 shadow-popover backdrop-blur-sm"
                                    aria-label="Previous step"
                                >
                                    <ChevronLeft size={16} />
                                </Button>
                            )}
                            {hasNext && (
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="icon"
                                    onClick={() => stepBy(1)}
                                    className="absolute top-1/2 right-2 -translate-y-1/2 rounded-full bg-surface/90 shadow-popover backdrop-blur-sm"
                                    aria-label="Next step"
                                >
                                    <ChevronRight size={16} />
                                </Button>
                            )}
                        </div>
                    )}
                </DialogContent>
            </Dialog>
        </div>
    );
}
