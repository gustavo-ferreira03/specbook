"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, FileCog } from "lucide-react";
import { RawFileEditor } from "@/components/RawFileEditor";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getContextFile, updateContextFile } from "@/lib/api";

export function ContextFileCard({ projectId }: { projectId: string }) {
    const [yaml, setYaml] = useState<string | null>(null);
    const [draft, setDraft] = useState("");
    const [syncError, setSyncError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const refresh = useCallback(async () => {
        setLoading(true);
        setError("");
        try {
            const result = await getContextFile(projectId);
            setYaml(result.yaml);
            setDraft(result.yaml ?? "");
            setSyncError(result.contextSyncError);
        } finally {
            setLoading(false);
        }
    }, [projectId]);

    useEffect(() => {
        refresh().catch((err: Error) => setError(err.message));
    }, [refresh]);

    async function save() {
        setBusy(true);
        setError("");
        try {
            const result = await updateContextFile(projectId, draft);
            setYaml(result.yaml);
            setDraft(result.yaml ?? "");
            setSyncError(result.contextSyncError);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    return (
        <section className="space-y-3" aria-labelledby="context-file-heading">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <FileCog className="size-4" aria-hidden />
                    <h2 id="context-file-heading" className="text-[0.8125rem] font-bold">Project context file</h2>
                </div>
            </div>
            <p className="max-w-[68ch] text-[0.65625rem] leading-5 text-ink-faint">
                The confirmed project context lives in the repository as context.yml. Edits are committed exactly as entered.
            </p>
            {error && (
                <Alert variant="destructive">
                    <AlertCircle className="size-4" aria-hidden />
                    <AlertTitle>Context file error</AlertTitle>
                    <AlertDescription>{error}</AlertDescription>
                </Alert>
            )}
            {syncError && (
                <Alert variant="warning">
                    <AlertCircle className="size-4" aria-hidden />
                    <AlertTitle>context.yml could not be parsed</AlertTitle>
                    <AlertDescription>{syncError}</AlertDescription>
                </Alert>
            )}
            {loading && (
                <div className="space-y-2" aria-label="Loading context.yml" aria-busy="true">
                    <Skeleton className="h-3 w-32" />
                    <Skeleton className="h-16 rounded-lg" />
                </div>
            )}
            {!loading && yaml === null && !error && (
                <p className="text-[0.6875rem] text-ink-faint">No context.yml yet. Confirm a discovery to create it.</p>
            )}
            {!loading && yaml !== null && (
                <div className="space-y-4">
                    <RawFileEditor id="context-yaml" label="context.yml" language="yaml" value={draft} onChange={setDraft} disabled={busy} rows={18} />
                    {draft !== yaml && (
                        <div className="flex flex-wrap justify-end gap-2">
                            <Button type="button" size="sm" variant="outline" onClick={() => setDraft(yaml)} disabled={busy}>Cancel</Button>
                            <Button type="button" size="sm" onClick={save} disabled={busy || !draft.trim()}>{busy ? "Saving..." : "Save changes"}</Button>
                        </div>
                    )}
                </div>
            )}
        </section>
    );
}
