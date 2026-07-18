"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, FileCog } from "lucide-react";
import { RawFileEditor } from "@/components/RawFileEditor";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { getContextFile, updateContextFile } from "@/lib/api";

export function ContextFileCard({ projectId }: { projectId: string }) {
    const [yaml, setYaml] = useState<string | null>(null);
    const [draft, setDraft] = useState("");
    const [syncError, setSyncError] = useState<string | null>(null);
    const [editing, setEditing] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const refresh = useCallback(async () => {
        const result = await getContextFile(projectId);
        setYaml(result.yaml);
        setSyncError(result.contextSyncError);
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
            setSyncError(result.contextSyncError);
            setEditing(false);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    return (
        <section className="space-y-3">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <FileCog className="size-4" aria-hidden />
                    <h2 className="text-sm font-medium">Project context file</h2>
                </div>
                {yaml !== null && !editing && (
                    <Button type="button" size="sm" variant="outline" onClick={() => { setDraft(yaml); setEditing(true); }}>
                        Edit context.yml
                    </Button>
                )}
            </div>
            <p className="text-xs text-muted-foreground">
                The confirmed project context lives in the repo as context.yml. Editing it here commits the raw file,
                exactly like editing it on GitHub.
            </p>
            {error && (
                <Alert variant="destructive">
                    <AlertCircle className="size-4" aria-hidden />
                    <AlertTitle>Context file error</AlertTitle>
                    <AlertDescription>{error}</AlertDescription>
                </Alert>
            )}
            {syncError && (
                <Alert>
                    <AlertCircle className="size-4" aria-hidden />
                    <AlertTitle>context.yml could not be parsed</AlertTitle>
                    <AlertDescription>{syncError}</AlertDescription>
                </Alert>
            )}
            {yaml === null && !error && (
                <p className="text-xs text-muted-foreground">No context.yml yet — confirm a discovery to create it.</p>
            )}
            {editing && (
                <div className="space-y-3">
                    <RawFileEditor id="context-yaml" label="context.yml" language="yaml" value={draft} onChange={setDraft} disabled={busy} rows={18} />
                    <div className="flex gap-2">
                        <Button type="button" size="sm" onClick={save} disabled={busy}>{busy ? "Saving..." : "Save"}</Button>
                        <Button type="button" size="sm" variant="outline" onClick={() => setEditing(false)} disabled={busy}>Cancel</Button>
                    </div>
                </div>
            )}
        </section>
    );
}
