"use client";

import { ChevronDown, FileCode2, Terminal, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { RunEvidence } from "@/lib/types";

const DIAGNOSTIC_LABELS = {
  console: "Console error",
  pageerror: "Page error",
  requestfailed: "Request failed",
  response: "HTTP error",
};

export const RunDiagnostics = function RunDiagnostics({
  evidence,
}: {
  evidence: RunEvidence;
}) {
  const diagnostics = evidence.diagnostics ?? [];
  if (
    diagnostics.length === 0 &&
    !evidence.errorContext &&
    !evidence.cleanupWarning
  ) {
    return null;
  }

  return (
    <div className="space-y-3">
      {evidence.cleanupWarning && (
        <p
          role="note"
          className="text-meta text-ink border-warning bg-warning-soft flex gap-2 rounded-lg border px-3 py-2.5"
        >
          <TriangleAlert
            size={14}
            aria-hidden="true"
            className="text-warning-icon mt-0.5 shrink-0"
          />
          <span className="min-w-0 break-words">{evidence.cleanupWarning}</span>
        </p>
      )}
      {diagnostics.length > 0 && (
        <Collapsible className="group/diagnostics border-line overflow-hidden rounded-lg border">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="text-control text-ink hover:bg-surface-soft focus-visible:ring-ring flex w-full items-center gap-2 px-3 py-2.5 text-left font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset"
            >
              <Terminal
                size={14}
                aria-hidden="true"
                className="text-ink-muted"
              />
              <span className="min-w-0 flex-1">Console and network</span>
              <span className="tabular text-meta text-ink-subtle">
                {diagnostics.length}
              </span>
              <ChevronDown
                size={13}
                aria-hidden="true"
                className="text-ink-subtle transition-transform group-data-[state=open]/diagnostics:rotate-180 motion-reduce:transition-none"
              />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent className="border-line bg-surface-soft border-t p-3">
            <ul
              className="max-h-80 space-y-4 overflow-auto"
              aria-label="Console and network failures"
            >
              {diagnostics.map((entry, index) => (
                <li key={index} className="min-w-0 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-body text-ink font-medium">
                      {DIAGNOSTIC_LABELS[entry.kind]}
                    </span>
                    {entry.status && (
                      <Badge variant="danger" size="sm">
                        {entry.status}
                      </Badge>
                    )}
                  </div>
                  <pre className="text-meta text-ink-muted break-words whitespace-pre-wrap">
                    {entry.message}
                  </pre>
                  {entry.url && (
                    <p className="text-meta text-ink-subtle font-mono break-all">
                      {entry.method && `${entry.method} `}
                      {entry.url}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}
      {evidence.errorContext && (
        <Collapsible className="group/context border-line overflow-hidden rounded-lg border">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="text-control text-ink hover:bg-surface-soft focus-visible:ring-ring flex w-full items-center gap-2 px-3 py-2.5 text-left font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset"
            >
              <FileCode2
                size={14}
                aria-hidden="true"
                className="text-ink-muted"
              />
              <span className="min-w-0 flex-1">Failure context</span>
              <ChevronDown
                size={13}
                aria-hidden="true"
                className="text-ink-subtle transition-transform group-data-[state=open]/context:rotate-180 motion-reduce:transition-none"
              />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent className="border-line bg-surface-soft border-t p-3">
            {/* oxlint-disable jsx-a11y/no-noninteractive-tabindex -- This scrollable evidence or command region must be keyboard focusable. */}
            <pre
              tabIndex={0}
              aria-label="Failure context and page snapshot"
              className="text-meta text-ink-muted focus-visible:ring-ring/20 max-h-80 overflow-auto break-words whitespace-pre-wrap outline-none focus-visible:ring-2"
            >
              {evidence.errorContext}
            </pre>
            {/* oxlint-enable jsx-a11y/no-noninteractive-tabindex */}
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
};
