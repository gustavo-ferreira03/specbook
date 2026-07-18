"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useCallback, useEffect, useState } from "react";
import { AlertCircle, ChevronDown, ChevronLeft, ChevronRight, ExternalLink, GitMerge, Images, PencilLine, Play, RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { SpecHistoryDialog } from "@/components/SpecHistoryDialog";
import { StatusPill } from "@/components/StatusPill";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { API_URL, api, resolveProjectGit } from "@/lib/api";
import type { Run, RunEvidence, SpecDetail } from "@/lib/types";

interface LoadedRunEvidence {
    data: RunEvidence | null;
    error: string;
}

function formatDuration(durationMs: number | null) {
    if (durationMs === null) return "Pending";
    if (durationMs < 1000) return `${durationMs}ms`;
    return `${(durationMs / 1000).toFixed(1)}s`;
}

function artifactUrl(runId: string, file: string) {
    const path = file.split("/").map(encodeURIComponent).join("/");
    return `${API_URL}/runs/${encodeURIComponent(runId)}/artifacts/${path}`;
}

function verificationSentence(run: Run) {
    const started = new Date(run.startedAt);
    const date = started.toLocaleDateString();
    const time = started.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const duration = run.durationMs === null ? "" : ` · Took ${formatDuration(run.durationMs)}`;
    return `Verified on ${date} at ${time}${duration}`;
}

async function loadRunEvidence(runs: Run[]): Promise<Record<string, LoadedRunEvidence>> {
    const entries = await Promise.all(runs.map(async (run) => {
        try {
            const data = await api<RunEvidence>(`/runs/${run.id}/evidence`);
            return [run.id, { data, error: "" }] as const;
        } catch (error) {
            return [run.id, { data: null, error: error instanceof Error ? error.message : String(error) }] as const;
        }
    }));
    return Object.fromEntries(entries);
}

function EvidenceGallery({ runId, evidence, onSelect }: { runId: string; evidence: RunEvidence; onSelect: (step: RunEvidence["steps"][number]) => void }) {
    if (evidence.steps.length === 0) return null;
    return (
        <section className="mt-4" aria-labelledby={`evidence-${runId}`}>
            <h4 id={`evidence-${runId}`} className="flex items-center gap-1.5 text-[0.6875rem] font-bold"><Images size={13} className="text-ink-faint" /> Evidence by step</h4>
            <ScrollArea orientation="horizontal" className="mt-2 w-full pb-2">
                <div className="flex w-max gap-2.5">
                    {evidence.steps.map((step) => (
                        <Button
                            key={step.file}
                            type="button"
                            variant="outline"
                            onClick={() => onSelect(step)}
                            className="h-auto w-52 flex-col items-stretch gap-0 overflow-hidden whitespace-normal rounded-[9px] p-0 text-left sm:w-56"
                        >
                            <img src={artifactUrl(runId, step.file)} alt="" loading="lazy" className="h-24 w-full object-cover" />
                            <span className="block px-2.5 pt-2 text-[0.59375rem] font-bold text-ink-faint">Step {step.number}</span>
                            <span className="min-h-10 px-2.5 pt-0.5 pb-2 text-[0.65625rem] font-semibold leading-4 break-words text-ink">{step.label}</span>
                        </Button>
                    ))}
                </div>
            </ScrollArea>
        </section>
    );
}

function VerificationDetails({
    run,
    loaded,
    onSelect,
    showReport = false,
}: {
    run: Run;
    loaded: LoadedRunEvidence | undefined;
    onSelect: (selection: { runId: string; step: RunEvidence["steps"][number] }) => void;
    showReport?: boolean;
}) {
    const evidence = loaded?.data;
    return (
        <div className="px-4 py-4 sm:px-5">
            {showReport && evidence?.reportUrl && (
                <div className="mb-3 flex justify-end">
                    <Button asChild variant="ghost" size="sm" className="text-ink-soft"><a href={`${API_URL}${evidence.reportUrl}`} target="_blank" rel="noreferrer">Report <ExternalLink size={10} /></a></Button>
                </div>
            )}
            {run.status === "passed" && evidence?.expectedResult && (
                <div>
                    <h4 className="text-[0.6875rem] font-bold">Expected result confirmed</h4>
                    <p className="mt-1 text-xs leading-5 text-ink-soft">{evidence.expectedResult}</p>
                </div>
            )}
            {run.status !== "passed" && run.failReason && (
                <Alert variant="destructive" className="text-[0.6875rem]" role="alert">
                    <AlertDescription className="whitespace-pre-wrap break-words">{run.failReason}</AlertDescription>
                </Alert>
            )}
            {!loaded && <Skeleton className="h-14 w-full rounded-[9px]" aria-label="Loading verification details" />}
            {loaded?.error && <Alert variant="destructive" className="text-[0.6875rem]" role="alert"><AlertDescription>Could not load verification details: {loaded.error}</AlertDescription></Alert>}
            {evidence?.video && run.status !== "passed" && (
                <section className="mt-4" aria-labelledby={`video-${run.id}`}>
                    <h4 id={`video-${run.id}`} className="text-[0.6875rem] font-bold">Watch execution</h4>
                    <video controls preload="metadata" className="mt-2 aspect-video w-full rounded-[9px] bg-browser" src={artifactUrl(run.id, evidence.video)} />
                </section>
            )}
            {evidence && <EvidenceGallery runId={run.id} evidence={evidence} onSelect={(step) => onSelect({ runId: run.id, step })} />}
        </div>
    );
}

function VerificationHeader({ run, loaded, collapsible = false }: { run: Run; loaded: LoadedRunEvidence | undefined; collapsible?: boolean }) {
    return (
        <div className="flex min-w-0 flex-1 flex-col gap-2 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-5">
            <div className="min-w-0">
                <StatusPill status={run.status} />
                <p className="mt-1.5 text-[0.6875rem] text-ink-soft">{verificationSentence(run)}</p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
                {!collapsible && loaded?.data?.reportUrl && (
                    <Button asChild variant="ghost" size="sm" className="text-ink-soft">
                        <a href={`${API_URL}${loaded.data.reportUrl}`} target="_blank" rel="noreferrer">Report <ExternalLink size={10} /></a>
                    </Button>
                )}
                {collapsible && <ChevronDown size={14} className="text-ink-faint transition-transform group-data-[state=open]/run:rotate-180" />}
            </div>
        </div>
    );
}

function PreviousVerification({ run, loaded, onSelect }: { run: Run; loaded: LoadedRunEvidence | undefined; onSelect: (selection: { runId: string; step: RunEvidence["steps"][number] }) => void }) {
    return (
        <Collapsible className="group/run border-b border-line last:border-0">
            <CollapsibleTrigger asChild>
                <Button type="button" variant="ghost" className="h-auto w-full justify-start whitespace-normal rounded-none p-0 text-left hover:bg-surface-soft"><VerificationHeader run={run} loaded={loaded} collapsible /></Button>
            </CollapsibleTrigger>
            <CollapsibleContent><Separator /><VerificationDetails run={run} loaded={loaded} onSelect={onSelect} showReport /></CollapsibleContent>
        </Collapsible>
    );
}

export default function SpecPage({ params }: { params: Promise<{ projectId: string; specId: string }> }) {
    const { projectId, specId } = use(params);
    const router = useRouter();
    const [detail, setDetail] = useState<SpecDetail | null>(null);
    const [evidence, setEvidence] = useState<Record<string, LoadedRunEvidence>>({});
    const [selectedEvidence, setSelectedEvidence] = useState<{ runId: string; step: RunEvidence["steps"][number] } | null>(null);
    const [loadError, setLoadError] = useState("");
    const [actionError, setActionError] = useState("");
    const [running, setRunning] = useState(false);
    const [resolving, setResolving] = useState(false);
    const [retryKey, setRetryKey] = useState(0);

    useEffect(() => {
        let active = true;
        setDetail(null);
        setEvidence({});
        setLoadError("");
        async function load() {
            try {
                const nextDetail = await api<SpecDetail>(`/specs/${specId}`);
                if (nextDetail.spec.projectId !== projectId) throw new Error("This Spec does not belong to this project.");
                if (!active) return;
                setDetail(nextDetail);
                const nextEvidence = await loadRunEvidence(nextDetail.runs);
                if (active) setEvidence(nextEvidence);
            } catch (error) {
                if (active) setLoadError(error instanceof Error ? error.message : String(error));
            }
        }
        void load();
        return () => {
            active = false;
        };
    }, [projectId, retryKey, specId]);

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
            await api<{ run: Run }>(`/specs/${specId}/run`, { method: "POST" });
            let nextDetail: SpecDetail;
            try {
                nextDetail = await api<SpecDetail>(`/specs/${specId}`);
            } catch (error) {
                if (error instanceof Error && error.message.includes("Spec not found")) {
                    router.replace(`/p/${projectId}/specs`);
                    return;
                }
                throw error;
            }
            if (nextDetail.spec.projectId !== projectId) throw new Error("This Spec does not belong to this project.");
            setDetail(nextDetail);
            setEvidence(await loadRunEvidence(nextDetail.runs));
        } catch (error) {
            setActionError(error instanceof Error ? error.message : String(error));
        } finally {
            setRunning(false);
        }
    }

    async function resolveConflict(keep: "local" | "remote") {
        if (!detail) return;
        setResolving(true);
        setActionError("");
        try {
            const { outcome } = await resolveProjectGit(projectId, [
                { path: `${detail.spec.path}/spec.md`, keep },
                { path: `${detail.spec.path}/spec.robot`, keep },
            ]);
            if (outcome.status === "conflict") {
                throw new Error("Other conflicting files still need an explicit choice in project settings.");
            }
            let nextDetail: SpecDetail;
            try {
                nextDetail = await api<SpecDetail>(`/specs/${specId}`);
            } catch (error) {
                if (error instanceof Error && error.message.includes("Spec not found")) {
                    router.replace(`/p/${projectId}/specs`);
                    return;
                }
                throw error;
            }
            if (nextDetail.spec.projectId !== projectId) throw new Error("This Spec does not belong to this project.");
            setDetail(nextDetail);
            setEvidence(await loadRunEvidence(nextDetail.runs));
        } catch (error) {
            setActionError(error instanceof Error ? error.message : String(error));
        } finally {
            setResolving(false);
        }
    }

    if (loadError && !detail) {
        return (
            <div className="flex min-h-full flex-col bg-surface">
                <PageHeader title="Spec" eyebrow="Specs" />
                <div className="flex flex-1 items-center justify-center px-5 py-10">
                    <Alert variant="destructive" className="max-w-sm bg-transparent p-0 text-center" role="alert">
                        <span className="mx-auto flex size-9 items-center justify-center rounded-lg bg-danger-soft text-danger"><AlertCircle size={18} /></span>
                        <h2 className="mt-4 text-sm font-bold text-ink">This Spec could not load</h2>
                        <AlertDescription className="mt-2 text-xs leading-5">{loadError}</AlertDescription>
                        <Button type="button" onClick={() => setRetryKey((key) => key + 1)} className="mt-5"><RefreshCw size={14} /> Try again</Button>
                    </Alert>
                </div>
            </div>
        );
    }

    if (!detail) {
        return (
            <div className="min-h-full bg-surface" aria-label="Loading Spec" aria-busy="true" role="status">
                <div className="h-16 border-b border-line md:h-[72px]" />
                <div className="mx-auto w-full max-w-[790px] space-y-4 px-5 py-8"><Skeleton className="h-4 w-24" /><Skeleton className="h-7 w-2/3" /><Skeleton className="h-52 rounded-[13px] bg-surface-soft" /></div>
            </div>
        );
    }

    const { spec, feature, content, runs } = detail;
    const latestRun = runs[0];
    const previousRuns = runs.slice(1);

    return (
        <div className="min-h-full bg-surface">
            <PageHeader title={spec.title} eyebrow={feature?.title ?? "Spec"} />
            <div className="mx-auto min-w-0 w-full max-w-[790px] px-4 py-7 [overflow-wrap:anywhere] sm:px-6 sm:py-8 lg:pb-14">
                <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                        <p className="text-[0.625rem] text-ink-faint">{feature?.title ?? "Specs"} / {spec.title}</p>
                        <h2 className="mt-2.5 max-w-[34ch] text-xl font-bold tracking-[-0.03em] text-balance">{spec.title}</h2>
                        {spec.description && <p className="mt-2 max-w-[65ch] text-xs leading-5 text-ink-soft">{spec.description}</p>}
                        <div className="mt-3 flex flex-wrap items-center gap-2"><StatusPill status={spec.status} /><span className="text-[0.625rem] text-ink-faint">Updated {new Date(spec.updatedAt).toLocaleDateString()}</span></div>
                    </div>
                    <div className="flex shrink-0 gap-2">
                        <SpecHistoryDialog specId={specId} />
                        <Button asChild variant="outline" className="flex-1 sm:flex-none"><Link href={`/p/${projectId}/chats/new?specId=${encodeURIComponent(spec.id)}`}><PencilLine size={13} /> Edit Spec</Link></Button>
                        <Button type="button" onClick={runNow} disabled={running || !content || spec.status === "invalid" || spec.status === "conflict"} className="flex-1 sm:flex-none"><Play size={12} fill="currentColor" /> {running ? "Running..." : "Run Spec"}</Button>
                    </div>
                </div>

                {actionError && <Alert variant="destructive" className="mt-5 flex items-start gap-2 text-xs" role="alert"><AlertCircle size={13} className="mt-1 shrink-0" /><AlertDescription>{actionError}</AlertDescription></Alert>}

                {spec.status === "invalid" && (
                    <Alert variant="invalid" className="mt-5" role="alert">
                        <AlertTitle>Spec is invalid</AlertTitle>
                        <AlertDescription>{spec.invalidReason ?? "The Markdown or Robot file could not be validated."}</AlertDescription>
                    </Alert>
                )}

                {spec.status === "conflict" && (
                    <Alert variant="conflict" className="mt-5" role="alert">
                        <div className="flex items-start gap-2">
                            <GitMerge size={14} className="mt-0.5 shrink-0" />
                            <div className="min-w-0 flex-1">
                                <AlertTitle>Git sync conflict</AlertTitle>
                                <AlertDescription className="mt-1">Choose which copy should replace both files for this Spec.</AlertDescription>
                                <div className="mt-2 flex flex-wrap gap-2">
                                    <Button type="button" size="sm" variant="outline" disabled={resolving} onClick={() => resolveConflict("local")}>Keep local</Button>
                                    <Button type="button" size="sm" variant="outline" disabled={resolving} onClick={() => resolveConflict("remote")}>Keep remote</Button>
                                </div>
                            </div>
                        </div>
                    </Alert>
                )}

                <section className="mt-7" aria-labelledby="specification-heading">
                    <h2 id="specification-heading" className="mb-2.5 text-[0.78125rem] font-bold">Specification</h2>
                    {content ? (
                        <div className="overflow-hidden rounded-[13px] border border-line">
                            <section className="px-4 py-3.5 sm:px-5">
                                <h3 className="text-[0.625rem] font-bold tracking-[0.06em] text-ink-faint uppercase">Preconditions</h3>
                                {content.humanSpec.preconditions.length ? <ul className="mt-2 list-disc space-y-1 pl-4 text-xs leading-5 marker:text-ink-faint">{content.humanSpec.preconditions.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul> : <p className="mt-2 text-xs leading-5 text-ink-faint">No preconditions recorded.</p>}
                            </section>
                            <Separator />
                            <section className="px-4 py-3.5 sm:px-5">
                                <h3 className="text-[0.625rem] font-bold tracking-[0.06em] text-ink-faint uppercase">Execution</h3>
                                {content.humanSpec.steps.length ? <ol className="mt-2 list-decimal space-y-1.5 pl-4 text-xs leading-5 marker:font-bold marker:text-ink-faint">{content.humanSpec.steps.map((item, index) => <li key={`${index}-${item}`} className="pl-1">{item}</li>)}</ol> : <p className="mt-2 text-xs leading-5 text-ink-faint">No execution steps recorded.</p>}
                            </section>
                            <Separator />
                            <section className="px-4 py-3.5 sm:px-5">
                                <h3 className="text-[0.625rem] font-bold tracking-[0.06em] text-ink-faint uppercase">Expected result</h3>
                                <p className="mt-2 text-xs leading-5 text-ink">{content.humanSpec.expectedResult || "No expected result recorded."}</p>
                            </section>
                            <Separator />
                            <section className="px-4 py-3.5 sm:px-5">
                                <h3 className="text-[0.625rem] font-bold tracking-[0.06em] text-ink-faint uppercase">Postconditions</h3>
                                {content.humanSpec.postconditions.length ? <ul className="mt-2 list-disc space-y-1 pl-4 text-xs leading-5 marker:text-ink-faint">{content.humanSpec.postconditions.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul> : <p className="mt-2 text-xs leading-5 text-ink-faint">No postconditions recorded.</p>}
                            </section>
                        </div>
                    ) : <div className="border-y border-line py-6 text-center"><p className="text-xs font-bold">Spec files unavailable</p><p className="mt-1 text-[0.6875rem] text-ink-faint">Restore or fix the Markdown and Robot files to continue.</p></div>}
                </section>

                <section className="mt-8" aria-labelledby="verification-heading">
                    <h2 id="verification-heading" className="text-[0.78125rem] font-bold">Verification</h2>
                    {!latestRun ? (
                        <div className="mt-2.5 border-y border-line py-6 text-center"><p className="text-xs font-bold">Not verified yet</p><p className="mt-1 text-[0.6875rem] text-ink-faint">Run this Spec to check the behavior.</p></div>
                    ) : (
                        <div className="mt-2.5 overflow-hidden rounded-[11px] border border-line">
                            <VerificationHeader run={latestRun} loaded={evidence[latestRun.id]} />
                            <Separator />
                            <VerificationDetails run={latestRun} loaded={evidence[latestRun.id]} onSelect={setSelectedEvidence} />
                        </div>
                    )}

                    {previousRuns.length > 0 && (
                        <Collapsible className="group/previous mt-4">
                            <CollapsibleTrigger asChild>
                                <Button variant="ghost" className="w-full justify-between px-1 text-[0.71875rem]">
                                    <span>Previous verifications ({previousRuns.length})</span>
                                    <ChevronDown size={14} className="text-ink-faint transition-transform group-data-[state=open]/previous:rotate-180" />
                                </Button>
                            </CollapsibleTrigger>
                            <CollapsibleContent className="mt-2 overflow-hidden rounded-[11px] border border-line">
                                {previousRuns.map((run) => <PreviousVerification key={run.id} run={run} loaded={evidence[run.id]} onSelect={setSelectedEvidence} />)}
                            </CollapsibleContent>
                        </Collapsible>
                    )}
                </section>
            </div>
            <Dialog open={selectedEvidence !== null} onOpenChange={(open) => {
                if (!open) setSelectedEvidence(null);
            }}>
                <DialogContent className="max-h-[calc(100dvh-24px)] max-w-[960px] overflow-y-auto p-4 sm:p-5">
                    <DialogHeader className="pr-8">
                        <DialogTitle>
                            Step {selectedEvidence?.step.number}
                            {selectedSteps.length > 1 && (
                                <span className="ml-2 font-normal text-ink-faint">{selectedIndex + 1} of {selectedSteps.length}</span>
                            )}
                        </DialogTitle>
                        <DialogDescription>{selectedEvidence?.step.label}</DialogDescription>
                    </DialogHeader>
                    {selectedEvidence && (
                        <div className="relative mt-3">
                            <img src={artifactUrl(selectedEvidence.runId, selectedEvidence.step.file)} alt={`Evidence for step ${selectedEvidence.step.number}: ${selectedEvidence.step.label}`} className="max-h-[calc(100dvh-150px)] w-full rounded-[9px] object-contain" />
                            {hasPrev && (
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="icon"
                                    onClick={() => stepBy(-1)}
                                    className="absolute top-1/2 left-2 -translate-y-1/2 rounded-full bg-surface/90 shadow-composer backdrop-blur-sm"
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
                                    className="absolute top-1/2 right-2 -translate-y-1/2 rounded-full bg-surface/90 shadow-composer backdrop-blur-sm"
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
