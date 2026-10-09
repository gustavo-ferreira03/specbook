"use client";

import { useEffect, useState } from "react";
import { AlertCircle, ChevronDown, CircleHelp, Clock3, ExternalLink, Minus, RefreshCw } from "lucide-react";
import { RunDiagnostics } from "@/components/RunDiagnostics";
import { StatusPill } from "@/components/StatusPill";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage, getRunEvidence, isAbortError } from "@/lib/api";
import { countLabel, formatDuration } from "@/lib/format";
import type { RunBatch, RunEvidence } from "@/lib/types";

export type SpecBatchStatus = "queued" | "running" | "passed" | "failed" | "error" | "skipped" | "unknown";

export interface SpecBatchItem {
    runId?: string;
    specId: string;
    title: string;
    status: SpecBatchStatus;
    durationMs: number | null;
    failReason: string | null;
}

function BatchDiagnostics({ runId }: { runId: string }) {
    const [open, setOpen] = useState(false);
    const [evidence, setEvidence] = useState<RunEvidence | null>(null);
    const [error, setError] = useState("");
    const [retryKey, setRetryKey] = useState(0);

    useEffect(() => {
        if (!open) return;
        const controller = new AbortController();
        setError("");
        getRunEvidence(runId, controller.signal)
            .then(setEvidence)
            .catch((error) => { if (!isAbortError(error)) setError(errorMessage(error)); });
        return () => controller.abort();
    }, [open, runId, retryKey]);

    return (
        <Collapsible open={open} onOpenChange={setOpen} className="mt-2">
            <CollapsibleTrigger asChild>
                <Button type="button" variant="ghost" size="sm" className="group/toggle h-7 px-2">Evidence <ChevronDown size={13} aria-hidden="true" className="transition-transform group-data-[state=open]/toggle:rotate-180 motion-reduce:transition-none" /></Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2">
                {error ? (
                    <Alert variant="danger" role="alert" className="space-y-2">
                        <AlertDescription>{error}</AlertDescription>
                        <Button type="button" size="sm" variant="outline" onClick={() => setRetryKey((key) => key + 1)}><RefreshCw size={13} /> Try again</Button>
                    </Alert>
                ) : !evidence ? (
                    <Skeleton className="h-14 w-full" aria-busy="true" aria-label="Loading diagnostics" role="status" />
                ) : evidence.diagnostics?.length || evidence.errorContext || evidence.apiSteps?.length ? (
                    <div className="space-y-3"><ApiRunEvidence evidence={evidence} /><RunDiagnostics evidence={evidence} /></div>
                ) : (
                    <p className="text-meta text-ink-subtle">No console or network failures were recorded.</p>
                )}
            </CollapsibleContent>
        </Collapsible>
    );
}

export function ApiRunEvidence({ evidence }: { evidence: RunEvidence }) {
    if (!evidence.apiSteps?.length) return null;
    return (
        <section aria-label="API evidence" className="space-y-3">
            <h4 className="text-meta font-semibold text-ink-muted">API requests by step</h4>
            {evidence.apiSteps.map((step) => (
                <div key={step.number} className="space-y-2">
                    <p className="text-control font-medium text-ink">{step.number}. {step.label}</p>
                    {step.requests.map((request, index) => (
                        <Collapsible key={index} className="group/api overflow-hidden rounded-lg border border-line">
                            <CollapsibleTrigger asChild>
                                <button type="button" className="flex w-full min-w-0 items-start gap-2 px-3 py-2 text-left outline-none hover:bg-surface-soft focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
                                    <span className="shrink-0 font-mono text-meta font-semibold text-ink-muted">{request.method}</span>
                                    <span className="min-w-0 flex-1 break-all text-meta text-ink">{request.url}</span>
                                    <span className="shrink-0 font-mono text-meta text-ink-muted">{request.status ?? "No response"}</span>
                                    <ChevronDown size={13} className="mt-0.5 shrink-0 text-ink-subtle transition-transform group-data-[state=open]/api:rotate-180 motion-reduce:transition-none" aria-hidden="true" />
                                </button>
                            </CollapsibleTrigger>
                            <CollapsibleContent className="space-y-3 border-t border-line bg-surface-soft px-3 py-3">
                                {request.error && <p className="text-meta break-words text-danger">{request.error}</p>}
                                <div className="space-y-1"><h5 className="text-meta font-medium text-ink">Request</h5><pre className="max-h-48 overflow-auto font-mono text-meta whitespace-pre-wrap break-all text-ink-muted">{JSON.stringify(request.requestHeaders, null, 2)}{request.requestBody ? `\n\n${request.requestBody}` : ""}</pre></div>
                                <div className="space-y-1"><h5 className="text-meta font-medium text-ink">Response</h5><pre className="max-h-48 overflow-auto font-mono text-meta whitespace-pre-wrap break-all text-ink-muted">{JSON.stringify(request.responseHeaders ?? {}, null, 2)}{request.responseBody ? `\n\n${request.responseBody}` : ""}</pre></div>
                            </CollapsibleContent>
                        </Collapsible>
                    ))}
                </div>
            ))}
        </section>
    );
}

function BatchStatus({ status }: { status: SpecBatchStatus }) {
    if (status === "passed" || status === "failed" || status === "error" || status === "running") return <StatusPill status={status} kind="run" size="sm" />;
    const Icon = status === "skipped" ? Minus : status === "unknown" ? CircleHelp : Clock3;
    const label = status === "skipped" ? "Skipped" : status === "unknown" ? "Unknown" : "Queued";
    return <Badge variant="neutral" size="sm" className="gap-1 pr-2.5 pl-1.5"><Icon size={12} strokeWidth={2.25} aria-hidden="true" /> {label}</Badge>;
}

export function SpecRunDialog({
    open,
    onOpenChange,
    title,
    items,
    running,
    reportUrl,
    error = "",
    warning = "",
    environment,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    items: SpecBatchItem[];
    running: boolean;
    reportUrl: string | null;
    error?: string;
    warning?: string;
    environment?: RunBatch["environment"] | null;
}) {
    const settled = items.filter((item) => item.status !== "queued" && item.status !== "running").length;
    const passed = items.filter((item) => item.status === "passed").length;
    const failed = items.filter((item) => item.status === "failed" || item.status === "error").length;
    const skipped = items.filter((item) => item.status === "skipped").length;

    const summary = [`${passed} passed`, failed ? `${failed} failed` : "", skipped ? `${skipped} skipped` : ""].filter(Boolean).join(", ");

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="flex h-[min(34rem,calc(100dvh-24px))] max-w-xl flex-col gap-0 overflow-hidden p-0 sm:p-0" showCloseButton={!running}>
                <DialogHeader className="shrink-0 px-5 pt-5 pb-4 pr-12">
                    <DialogTitle>{title}</DialogTitle>
                    <DialogDescription>
                        {running
                            ? `Running ${countLabel(items.length, "Spec")} together. You can keep this open to follow along.`
                            : `${summary} across ${countLabel(items.length, "Spec")}.`}
                    </DialogDescription>
                    {environment && <p className="mt-1 break-words text-meta text-ink-muted"><span className="font-medium text-ink">{environment.name}</span> · {environment.baseUrl}</p>}
                </DialogHeader>

                <div className="shrink-0 border-y border-line bg-surface-soft px-5 py-3" aria-live="polite">
                    <div className="flex items-center justify-between gap-3 text-meta text-ink-muted">
                        <span className="font-medium text-ink">{running ? `${settled} of ${items.length} completed` : error ? "Results incomplete" : "Run completed"}</span>
                        <span className="tabular">{passed} passed · {failed} failed</span>
                    </div>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-selected" role="progressbar" aria-label="Run progress" aria-valuemin={0} aria-valuemax={items.length} aria-valuenow={settled}>
                        <div className="h-full rounded-full bg-primary transition-[width] duration-200 motion-reduce:transition-none" style={{ width: `${items.length ? (settled / items.length) * 100 : 0}%` }} />
                    </div>
                    {warning && (
                        <p className="mt-2 flex items-start gap-1.5 text-meta text-ink [&_svg]:text-warning-icon" role="status">
                            <AlertCircle size={13} className="mt-0.5 shrink-0" aria-hidden="true" /> {warning}
                        </p>
                    )}
                </div>

                {error && (
                    <Alert variant="danger" className="mx-5 mt-4 w-auto shrink-0" role="alert">
                        <AlertDescription className="break-words">{error}</AlertDescription>
                    </Alert>
                )}

                <ScrollArea className="min-h-0 flex-1">
                    <ul className="divide-y divide-line px-5" aria-label="Specs in this run">
                        {items.map((item) => (
                            <li key={item.specId} className="flex min-w-0 items-start gap-3 py-3">
                                <span className="w-20 shrink-0 pt-0.5"><BatchStatus status={item.status} /></span>
                                <div className="min-w-0 flex-1">
                                    <p className="text-control font-medium break-words text-ink">{item.title}</p>
                                    {item.failReason && <p className="mt-1 line-clamp-4 font-mono text-meta whitespace-pre-wrap break-words text-danger">{item.failReason}</p>}
                                    {item.runId && ["passed", "failed", "error"].includes(item.status) && <BatchDiagnostics runId={item.runId} />}
                                </div>
                                {item.durationMs !== null && <span className="shrink-0 pt-0.5 text-meta text-ink-subtle tabular">{formatDuration(item.durationMs)}</span>}
                            </li>
                        ))}
                    </ul>
                </ScrollArea>

                <DialogFooter className="shrink-0 border-t border-line px-5 py-3">
                    {reportUrl && <Button asChild variant="outline"><a href={reportUrl} target="_blank" rel="noreferrer">Open report <ExternalLink size={13} /></a></Button>}
                    <DialogClose asChild>
                        <Button type="button" disabled={running}>{running ? "Running…" : "Close"}</Button>
                    </DialogClose>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
