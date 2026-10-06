"use client";

import { AlertCircle, CircleHelp, Clock3, ExternalLink, Minus } from "lucide-react";
import { StatusPill } from "@/components/StatusPill";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { formatDuration } from "@/lib/format";

export type SpecBatchStatus = "queued" | "running" | "passed" | "failed" | "error" | "skipped" | "unknown";

export interface SpecBatchItem {
    specId: string;
    title: string;
    status: SpecBatchStatus;
    durationMs: number | null;
    failReason: string | null;
}

/** Run statuses use the shared StatusPill; batch-only states (queued, skipped, unknown) are neutral. */
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
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    items: SpecBatchItem[];
    running: boolean;
    reportUrl: string | null;
    error?: string;
    warning?: string;
}) {
    const settled = items.filter((item) => item.status !== "queued" && item.status !== "running").length;
    const passed = items.filter((item) => item.status === "passed").length;
    const failed = items.filter((item) => item.status === "failed" || item.status === "error").length;
    const skipped = items.filter((item) => item.status === "skipped").length;

    const noun = items.length === 1 ? "Spec" : "Specs";
    const summary = [`${passed} passed`, failed ? `${failed} failed` : "", skipped ? `${skipped} skipped` : ""].filter(Boolean).join(", ");

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="flex h-[min(34rem,calc(100dvh-24px))] max-w-xl flex-col gap-0 overflow-hidden p-0 sm:p-0" showCloseButton={!running}>
                <DialogHeader className="shrink-0 px-5 pt-5 pb-4 pr-12">
                    <DialogTitle>{title}</DialogTitle>
                    <DialogDescription>
                        {running
                            ? `Running ${items.length} ${noun} together. You can keep this open to follow along.`
                            : `${summary} across ${items.length} ${noun}.`}
                    </DialogDescription>
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
                                </div>
                                {item.durationMs !== null && <span className="shrink-0 pt-0.5 text-meta text-ink-subtle tabular">{formatDuration(item.durationMs)}</span>}
                            </li>
                        ))}
                    </ul>
                </ScrollArea>

                <DialogFooter className="shrink-0 border-t border-line px-5 py-3">
                    {reportUrl && <Button asChild variant="outline"><a href={reportUrl} target="_blank" rel="noreferrer">Open report <ExternalLink size={13} /></a></Button>}
                    <DialogClose asChild>
                        <Button type="button" disabled={running}>{running ? "Running..." : "Close"}</Button>
                    </DialogClose>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
