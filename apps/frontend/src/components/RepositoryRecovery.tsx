"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, RefreshCw } from "lucide-react";
import { FileDiff, type ProposalFile } from "@/components/FileDiff";
import { InlineFeedback, SettingsBlock, SettingsSection } from "@/components/SettingsLayout";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { api, apiPath, errorMessage } from "@/lib/api";

interface Recovery {
    dirty: boolean;
    blocked: boolean;
    fingerprint: string;
    files: (ProposalFile & { deleted: boolean })[];
    canSave: boolean;
    message: string;
}

export function RepositoryRecovery({ projectId }: { projectId: string }) {
    const [recovery, setRecovery] = useState<Recovery | null>(null);
    const [open, setOpen] = useState(false);
    const [saving, setSaving] = useState(false);
    const [loading, setLoading] = useState(false);
    const [feedback, setFeedback] = useState<{ type: "success" | "error"; text: string } | null>(null);
    const trigger = useRef<HTMLButtonElement | null>(null);
    const load = useCallback(async () => {
        setLoading(true);
        try { setRecovery(await api<Recovery>(apiPath`/projects/${projectId}/repository/recovery`)); }
        catch (reason) { setFeedback({ type: "error", text: errorMessage(reason) }); }
        finally { setLoading(false); }
    }, [projectId]);

    useEffect(() => { void load(); }, [load]);

    async function save() {
        if (!recovery?.canSave) return;
        setSaving(true);
        setFeedback(null);
        try {
            const result = await api<{ message: string }>(apiPath`/projects/${projectId}/repository/recovery`, { method: "POST", body: JSON.stringify({ fingerprint: recovery.fingerprint }) });
            setFeedback({ type: "success", text: result.message });
            setOpen(false);
            await load();
        } catch (reason) { setFeedback({ type: "error", text: errorMessage(reason) }); }
        finally { setSaving(false); }
    }

    if (!recovery?.dirty && !recovery?.blocked && !feedback) return null;
    return <>
        <SettingsSection id="pending-edits-heading" title={recovery?.blocked ? "Project files need attention" : "Pending file edits"} description="Review changes made directly to this project's files before running checks.">
            <SettingsBlock>
                {(recovery?.dirty || recovery?.blocked) && <p className="mb-3 text-body text-ink-muted">{recovery.message}</p>}
                <InlineFeedback feedback={feedback} />
                {recovery?.canSave && <Button ref={trigger} variant="outline" className="mt-2" onClick={() => { setFeedback(null); setOpen(true); }}>Review {recovery.files.length} changed {recovery.files.length === 1 ? "file" : "files"}</Button>}
                {!recovery?.canSave && feedback?.type === "error" && <Button variant="outline" className="mt-2" onClick={() => void load()} disabled={loading}><RefreshCw size={14} /> Try again</Button>}
            </SettingsBlock>
        </SettingsSection>
        <Sheet open={open} onOpenChange={(value) => { if (!saving) setOpen(value); }}>
            <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl" onCloseAutoFocus={(event) => { event.preventDefault(); trigger.current?.focus(); }}>
                <SheetHeader className="border-b border-line px-5 py-5 pr-12"><SheetTitle>Save pending edits?</SheetTitle><SheetDescription>Review every file below. Saving commits these changes to the project, including any changes to its expected behavior.</SheetDescription></SheetHeader>
                <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-5">
                    {recovery?.files.map((file) => <div key={file.path}>{file.deleted && <p className="mb-1 text-body text-danger">This file will be deleted.</p>}<FileDiff file={file} /></div>)}
                </div>
                <div className="space-y-3 border-t border-line bg-surface-soft px-5 py-4">
                    <InlineFeedback feedback={feedback} />
                    <div className="flex flex-wrap justify-end gap-2"><Button variant="outline" onClick={() => void load()} disabled={saving || loading}><RefreshCw size={14} /> Refresh changes</Button><Button onClick={() => void save()} disabled={saving || loading || !recovery?.canSave}>{saving ? "Saving..." : "Save pending edits"}</Button></div>
                    <p className="flex items-start gap-2 text-meta text-ink-subtle"><AlertCircle size={13} className="mt-0.5 shrink-0" />Saving preserves the edited files. Specbook does not discard or rewrite your changes.</p>
                </div>
            </SheetContent>
        </Sheet>
    </>;
}
