"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Compass, FileCog } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { RawFileEditor } from "@/components/RawFileEditor";
import { InlineFeedback, SettingsBlock, SettingsFooter, SettingsSection } from "@/components/SettingsLayout";
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
    const [saved, setSaved] = useState(false);

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
        setSaved(false);
        try {
            const result = await updateContextFile(projectId, draft);
            setYaml(result.yaml);
            setDraft(result.yaml ?? "");
            setSyncError(result.contextSyncError);
            setSaved(true);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    const dirty = yaml !== null && draft !== yaml;

    return (
        <div className="space-y-6">
            <SettingsSection
                id="context-file-heading"
                title="Project context file"
                description={<>The confirmed project context lives in the repository as <code className="font-mono text-meta text-ink">context.yml</code>. Edits are committed exactly as entered.</>}
                actions={yaml !== null &&
                    <Button asChild variant="outline">
                        <Link href={`/p/${projectId}`}><Compass size={14} /> Overview</Link>
                    </Button>
                }
            >
                {syncError && (
                    <SettingsBlock>
                        <Alert variant="warning" role="alert">
                            <AlertTitle>context.yml could not be parsed</AlertTitle>
                            <AlertDescription className="break-words">{syncError}</AlertDescription>
                        </Alert>
                    </SettingsBlock>
                )}
                {loading && (
                    <SettingsBlock>
                        <div className="space-y-2" aria-label="Loading context.yml" aria-busy="true" role="status">
                            <Skeleton className="h-4 w-24" />
                            <Skeleton className="h-72 rounded-lg" />
                        </div>
                    </SettingsBlock>
                )}
                {!loading && yaml === null && !error && (
                    <EmptyState
                        size="compact"
                        icon={FileCog}
                        title="No context.yml yet"
                        description="Run a discovery from the overview and confirm it to create the file."
                        action={<Button asChild size="sm"><Link href={`/p/${projectId}`}><Compass size={14} /> Go to discovery</Link></Button>}
                        className="py-10"
                    />
                )}
                {!loading && yaml === null && error && (
                    <SettingsBlock><InlineFeedback feedback={{ type: "error", text: error }} /></SettingsBlock>
                )}
                {!loading && yaml !== null && (
                    <>
                        <SettingsBlock>
                            <RawFileEditor id="context-yaml" label="context.yml" language="yaml" value={draft} onChange={setDraft} disabled={busy} rows={18} />
                        </SettingsBlock>
                        <SettingsFooter
                            feedback={error ? <InlineFeedback feedback={{ type: "error", text: error }} /> : dirty ? <span className="text-control text-ink-muted">Unsaved changes</span> : saved ? <InlineFeedback feedback={{ type: "success", text: "context.yml saved and committed." }} /> : null}
                        >
                            {dirty && <Button type="button" variant="ghost" onClick={() => { setDraft(yaml); setError(""); }} disabled={busy}>Discard changes</Button>}
                            <Button type="button" onClick={save} disabled={busy || !dirty || !draft.trim()}>{busy ? "Saving…" : "Save changes"}</Button>
                        </SettingsFooter>
                    </>
                )}
            </SettingsSection>
        </div>
    );
}
