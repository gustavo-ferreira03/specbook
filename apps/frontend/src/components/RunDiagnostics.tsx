"use client";

import { ChevronDown, FileCode2, Terminal } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { RunEvidence } from "@/lib/types";

const DIAGNOSTIC_LABELS = {
    console: "Console error",
    pageerror: "Page error",
    requestfailed: "Request failed",
    response: "HTTP error",
};

export function RunDiagnostics({ evidence }: { evidence: RunEvidence }) {
    const diagnostics = evidence.diagnostics ?? [];
    if (diagnostics.length === 0 && !evidence.errorContext) return null;

    return (
        <div className="space-y-3">
            {diagnostics.length > 0 && (
                <Collapsible className="group/diagnostics overflow-hidden rounded-lg border border-line">
                    <CollapsibleTrigger asChild>
                        <button type="button" className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-control font-medium text-ink outline-none transition-colors hover:bg-surface-soft focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
                            <Terminal size={14} aria-hidden="true" className="text-ink-muted" />
                            <span className="min-w-0 flex-1">Console and network</span>
                            <span className="tabular text-meta text-ink-subtle">{diagnostics.length}</span>
                            <ChevronDown size={13} aria-hidden="true" className="text-ink-subtle transition-transform group-data-[state=open]/diagnostics:rotate-180 motion-reduce:transition-none" />
                        </button>
                    </CollapsibleTrigger>
                    <CollapsibleContent className="border-t border-line bg-surface-soft p-3">
                        <ul className="max-h-80 space-y-4 overflow-auto" aria-label="Console and network failures">
                            {diagnostics.map((entry, index) => (
                                <li key={index} className="min-w-0 space-y-1.5">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="text-body font-medium text-ink">{DIAGNOSTIC_LABELS[entry.kind]}</span>
                                        {entry.status && <Badge variant="danger" size="sm">{entry.status}</Badge>}
                                    </div>
                                    <pre className="whitespace-pre-wrap break-words text-meta text-ink-muted">{entry.message}</pre>
                                    {entry.url && <p className="break-all font-mono text-meta text-ink-subtle">{entry.method && `${entry.method} `}{entry.url}</p>}
                                </li>
                            ))}
                        </ul>
                    </CollapsibleContent>
                </Collapsible>
            )}
            {evidence.errorContext && (
                <Collapsible className="group/context overflow-hidden rounded-lg border border-line">
                    <CollapsibleTrigger asChild>
                        <button type="button" className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-control font-medium text-ink outline-none transition-colors hover:bg-surface-soft focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
                            <FileCode2 size={14} aria-hidden="true" className="text-ink-muted" />
                            <span className="min-w-0 flex-1">Failure context</span>
                            <ChevronDown size={13} aria-hidden="true" className="text-ink-subtle transition-transform group-data-[state=open]/context:rotate-180 motion-reduce:transition-none" />
                        </button>
                    </CollapsibleTrigger>
                    <CollapsibleContent className="border-t border-line bg-surface-soft p-3">
                        <pre tabIndex={0} aria-label="Failure context and page snapshot" className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-meta text-ink-muted outline-none focus-visible:ring-2 focus-visible:ring-ring/20">{evidence.errorContext}</pre>
                    </CollapsibleContent>
                </Collapsible>
            )}
        </div>
    );
}
