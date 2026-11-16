"use client";

import { FileCode2, History } from "lucide-react";
import { useEffect, useState } from "react";

import { HighlightedCode } from "@/components/RawFileEditor";
import type { EditorLanguage } from "@/components/RawFileEditor";
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
import { formatDateTime } from "@/lib/format";

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
  const [contents, setContents] = useState<{
    yaml: string | null;
    testSource: string | null;
  } | null>(null);
  const [contentsLoading, setContentsLoading] = useState(false);
  const [error, setError] = useState("");
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    if (!open) {
      return;
    }
    let active = true;
    setEntries(null);
    setSelected(null);
    setContents(null);
    setError("");
    setEntriesLoading(true);
    getSpecHistory(specId)
      .then((result) => {
        if (!active) {
          return;
        }
        setEntries(result.entries);
        setSelected(result.entries[0] ?? null);
      })
      .catch((caught: Error) => {
        if (active) {
          setError(caught.message);
        }
      })
      .finally(() => {
        if (active) {
          setEntriesLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [open, retryKey, specId]);

  useEffect(() => {
    if (!selected) {
      return;
    }
    let active = true;
    setContents(null);
    setError("");
    setContentsLoading(true);
    getSpecAtCommit(specId, selected.sha)
      .then((result) => {
        if (active) {
          setContents(result);
        }
      })
      .catch((caught: Error) => {
        if (active) {
          setError(caught.message);
        }
      })
      .finally(() => {
        if (active) {
          setContentsLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [retryKey, selected, specId]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" size="sm">
          <History size={13} /> Versions
        </Button>
      </DialogTrigger>
      <DialogContent className="flex h-[min(720px,calc(100dvh-24px))] max-w-[920px] flex-col gap-0 overflow-hidden p-0 sm:p-0">
        <DialogHeader className="shrink-0 px-5 pt-5 pr-12 pb-4">
          <DialogTitle>Spec history</DialogTitle>
          <DialogDescription>
            Every committed change to this Spec and its automation, newest
            first.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <Alert
            variant="danger"
            className="mx-5 mb-4 flex w-auto items-center justify-between gap-3"
            role="alert"
          >
            <AlertDescription>{error}</AlertDescription>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setRetryKey((value) => value + 1)}
            >
              Retry
            </Button>
          </Alert>
        )}
        <div className="border-line grid min-h-0 flex-1 grid-rows-[minmax(7rem,0.35fr)_minmax(0,1fr)] border-t md:grid-cols-[240px_minmax(0,1fr)] md:grid-rows-1">
          <ScrollArea className="bg-surface-soft min-h-0">
            {entriesLoading ? (
              <div className="space-y-2 p-3">
                <Skeleton className="h-11" />
                <Skeleton className="h-11" />
                <Skeleton className="h-11" />
              </div>
            ) : entries ? (
              entries.length === 0 ? (
                <p className="text-control text-ink-subtle p-4">
                  No changes recorded yet.
                </p>
              ) : (
                <ul className="space-y-0.5 p-2" aria-label="Commits">
                  {entries.map((entry) => (
                    <li key={entry.sha}>
                      <button
                        type="button"
                        onClick={() => setSelected(entry)}
                        aria-pressed={selected?.sha === entry.sha}
                        className={`hover:bg-surface-hover focus-visible:ring-ring w-full rounded-md px-2.5 py-2 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset ${selected?.sha === entry.sha ? "bg-surface-selected hover:bg-surface-selected" : ""}`}
                      >
                        <span className="text-control text-ink block truncate font-medium">
                          {entry.message}
                        </span>
                        <span className="text-meta text-ink-subtle mt-0.5 flex items-center gap-1.5">
                          <span className="tabular">
                            {formatDateTime(entry.date)}
                          </span>
                          <span
                            aria-hidden="true"
                            className="text-ink-disabled"
                          >
                            ·
                          </span>
                          <span className="font-mono">
                            {entry.sha.slice(0, 7)}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )
            ) : null}
          </ScrollArea>
          <ScrollArea className="min-h-0">
            {!selected && entries?.length !== 0 && (
              <p className="text-control text-ink-subtle p-5">
                Select a commit to inspect its files.
              </p>
            )}
            {selected && contentsLoading && (
              <div className="space-y-3 p-4 sm:p-5">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-32" />
              </div>
            )}
            {selected && contents && (
              <div className="min-w-0 p-4 sm:p-5">
                <FileContent
                  label="spec.yml"
                  language="yaml"
                  source={contents.yaml}
                />
                <FileContent
                  label="spec.ts"
                  language="typescript"
                  source={contents.testSource}
                  className="mt-6"
                />
              </div>
            )}
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function FileContent({
  label,
  language,
  source,
  className = "",
}: {
  label: string;
  language: EditorLanguage;
  source: string | null;
  className?: string;
}) {
  return (
    <section className={className}>
      <h3 className="text-meta text-ink-muted flex items-center gap-1.5 font-mono font-medium">
        <FileCode2 size={13} aria-hidden="true" /> {label}
      </h3>
      {source === null ? (
        <p className="border-line-strong text-control text-ink-subtle mt-2 rounded-lg border border-dashed px-3 py-4">
          This file did not exist in this commit.
        </p>
      ) : (
        <HighlightedCode
          label={`${label} at selected commit`}
          language={language}
          source={source}
          className="mt-2"
        />
      )}
    </section>
  );
}
