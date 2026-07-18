"use client";

import { useEffect, useState } from "react";
import { FileCode2, History } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { getSpecAtCommit, getSpecHistory } from "@/lib/api";

interface HistoryEntry {
    sha: string;
    date: string;
    message: string;
}

export function SpecHistoryDialog({ specId }: { specId: string }) {
    const [open, setOpen] = useState(false);
    const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
    const [entriesLoading, setEntriesLoading] = useState(false);
    const [selected, setSelected] = useState<HistoryEntry | null>(null);
    const [contents, setContents] = useState<{ markdown: string | null; robot: string | null } | null>(null);
    const [contentsLoading, setContentsLoading] = useState(false);
    const [error, setError] = useState("");
    const [retryKey, setRetryKey] = useState(0);

    useEffect(() => {
        if (!open) return;
        let active = true;
        setEntries(null);
        setSelected(null);
        setContents(null);
        setError("");
        setEntriesLoading(true);
        getSpecHistory(specId)
            .then((result) => {
                if (!active) return;
                setEntries(result.entries);
                setSelected(result.entries[0] ?? null);
            })
            .catch((caught: Error) => {
                if (active) setError(caught.message);
            })
            .finally(() => {
                if (active) setEntriesLoading(false);
            });
        return () => {
            active = false;
        };
    }, [open, retryKey, specId]);

    useEffect(() => {
        if (!selected) return;
        let active = true;
        setContents(null);
        setError("");
        setContentsLoading(true);
        getSpecAtCommit(specId, selected.sha)
            .then((result) => {
                if (active) setContents(result);
            })
            .catch((caught: Error) => {
                if (active) setError(caught.message);
            })
            .finally(() => {
                if (active) setContentsLoading(false);
            });
        return () => {
            active = false;
        };
    }, [retryKey, selected, specId]);

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                <Button type="button" variant="outline">
                    <History size={13} /> History
                </Button>
            </DialogTrigger>
            <DialogContent className="flex h-[min(720px,calc(100dvh-24px))] max-w-[920px] flex-col overflow-hidden p-0">
                <DialogHeader className="shrink-0 px-4 pt-4 pr-12 pb-3 sm:px-5 sm:pt-5 sm:pr-12">
                    <DialogTitle>Spec history</DialogTitle>
                    <DialogDescription>Committed changes to the Markdown specification and Robot executable.</DialogDescription>
                </DialogHeader>
                {error && (
                    <Alert variant="destructive" className="mx-4 mb-3 flex w-auto items-center justify-between gap-3 sm:mx-5" role="alert">
                        <AlertDescription>{error}</AlertDescription>
                        <Button type="button" size="sm" variant="outline" onClick={() => setRetryKey((value) => value + 1)}>Retry</Button>
                    </Alert>
                )}
                <div className="grid min-h-0 flex-1 grid-rows-[minmax(7rem,0.35fr)_minmax(0,1fr)] border-t border-line md:grid-cols-[240px_minmax(0,1fr)] md:grid-rows-1">
                    <ScrollArea className="min-h-0 border-b border-line md:border-r md:border-b-0">
                        {entriesLoading ? (
                            <div className="space-y-2 p-3"><Skeleton className="h-11" /><Skeleton className="h-11" /><Skeleton className="h-11" /></div>
                        ) : !entries ? null : entries.length === 0 ? (
                            <p className="p-4 text-[0.6875rem] text-ink-faint">No changes recorded yet.</p>
                        ) : (
                            <ul className="p-1.5">
                                {entries.map((entry) => (
                                    <li key={entry.sha}>
                                        <button
                                            type="button"
                                            onClick={() => setSelected(entry)}
                                            aria-pressed={selected?.sha === entry.sha}
                                            className={`w-full rounded-md px-2.5 py-2 text-left outline-none transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/35 ${selected?.sha === entry.sha ? "bg-surface-selected" : ""}`}
                                        >
                                            <span className="block truncate text-[0.6875rem] font-bold">{entry.message}</span>
                                            <span className="mt-0.5 block text-[0.59375rem] text-ink-faint">
                                                {new Date(entry.date).toLocaleString()} · {entry.sha.slice(0, 7)}
                                            </span>
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </ScrollArea>
                    <ScrollArea className="min-h-0">
                        {!selected && entries?.length !== 0 && <p className="p-5 text-[0.6875rem] text-ink-faint">Select a commit to inspect its files.</p>}
                        {selected && contentsLoading && <div className="space-y-3 p-4 sm:p-5"><Skeleton className="h-4 w-32" /><Skeleton className="h-32" /></div>}
                        {selected && contents && (
                            <div className="min-w-0 p-4 sm:p-5">
                                <FileContent label="Specification (.md)" source={contents.markdown} />
                                <FileContent label="Executable (.robot)" source={contents.robot} className="mt-5 border-t border-line pt-5" />
                            </div>
                        )}
                    </ScrollArea>
                </div>
            </DialogContent>
        </Dialog>
    );
}

function FileContent({ label, source, className = "" }: { label: string; source: string | null; className?: string }) {
    return (
        <section className={className}>
            <h3 className="flex items-center gap-1.5 text-[0.625rem] font-bold text-ink-soft"><FileCode2 size={12} /> {label}</h3>
            <pre className="mt-2 max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-[8px] bg-surface-soft p-3 font-mono text-[0.65625rem] leading-5 text-ink">{source ?? "File absent in this commit."}</pre>
        </section>
    );
}
