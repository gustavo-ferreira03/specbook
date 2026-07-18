"use client";

import { Check, Clock3, ExternalLink, LoaderCircle, Minus, OctagonX } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";

export type SpecBatchStatus = "queued" | "running" | "passed" | "failed" | "error" | "skipped";

export interface SpecBatchItem {
    specId: string;
    title: string;
    status: SpecBatchStatus;
    durationMs: number | null;
    failReason: string | null;
}

function duration(value: number | null) {
    if (value === null) return "";
    if (value < 1000) return `${value}ms`;
    return `${(value / 1000).toFixed(1)}s`;
}

function BatchStatus({ status }: { status: SpecBatchStatus }) {
    if (status === "passed") return <Badge variant="success"><Check size={11} /> Passed</Badge>;
    if (status === "failed") return <Badge variant="danger"><OctagonX size={11} /> Failed</Badge>;
    if (status === "error") return <Badge variant="danger"><OctagonX size={11} /> Error</Badge>;
    if (status === "running") return <Badge variant="secondary"><LoaderCircle size={11} className="animate-spin motion-reduce:animate-none" /> Running</Badge>;
    if (status === "skipped") return <Badge variant="secondary"><Minus size={11} /> Skipped</Badge>;
    return <Badge variant="secondary"><Clock3 size={11} /> Queued</Badge>;
}

export function SpecRunDialog({
    open,
    onOpenChange,
    title,
    items,
    running,
    reportUrl,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    items: SpecBatchItem[];
    running: boolean;
    reportUrl: string | null;
}) {
    const settled = items.filter((item) => item.status !== "queued" && item.status !== "running").length;
    const passed = items.filter((item) => item.status === "passed").length;
    const failed = items.filter((item) => item.status === "failed" || item.status === "error").length;
    const skipped = items.filter((item) => item.status === "skipped").length;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="flex max-h-[calc(100dvh-24px)] max-w-xl flex-col overflow-hidden p-0" showCloseButton={!running}>
                <DialogHeader className="border-b border-line px-4 py-4 pr-12">
                    <DialogTitle>{title}</DialogTitle>
                    <DialogDescription>
                        {running
                            ? `Running ${items.length} ${items.length === 1 ? "Spec" : "Specs"} in one Robot suite.`
                            : `${passed} passed${failed ? `, ${failed} failed` : ""}${skipped ? `, ${skipped} skipped` : ""} across ${items.length} ${items.length === 1 ? "Spec" : "Specs"}.`}
                    </DialogDescription>
                </DialogHeader>

                <div className="border-b border-line px-4 py-3" aria-live="polite">
                    <div className="flex items-center justify-between gap-3 text-[0.65625rem] font-semibold text-ink-soft">
                        <span>{running ? `${settled} of ${items.length} completed` : "Run completed"}</span>
                        <span>{passed} passed · {failed} failed</span>
                    </div>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-hover" role="progressbar" aria-valuemin={0} aria-valuemax={items.length} aria-valuenow={settled}>
                        <div className="h-full rounded-full bg-primary" style={{ width: `${items.length ? (settled / items.length) * 100 : 0}%` }} />
                    </div>
                </div>

                <ScrollArea className="min-h-0 flex-1">
                    <div className="divide-y divide-line px-4">
                        {items.map((item) => (
                            <div key={item.specId} className="py-3">
                                <div className="flex min-w-0 items-start justify-between gap-3">
                                    <div className="min-w-0 flex-1">
                                        <p className="text-xs font-semibold leading-5 break-words">{item.title}</p>
                                        {item.failReason && <p className="mt-1 whitespace-pre-wrap text-[0.65625rem] leading-4 break-words text-danger">{item.failReason}</p>}
                                    </div>
                                    <div className="flex shrink-0 items-center gap-2">
                                        {item.durationMs !== null && <span className="text-[0.625rem] text-ink-faint">{duration(item.durationMs)}</span>}
                                        <BatchStatus status={item.status} />
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </ScrollArea>

                <DialogFooter className="border-t border-line px-4 py-3">
                    {reportUrl && <Button asChild variant="outline"><a href={reportUrl} target="_blank" rel="noreferrer">Open report <ExternalLink size={12} /></a></Button>}
                    <DialogClose asChild>
                        <Button type="button" disabled={running}>Close results</Button>
                    </DialogClose>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
