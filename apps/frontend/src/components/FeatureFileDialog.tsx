"use client";

import { useState } from "react";
import { FileCog } from "lucide-react";
import { RawFileEditor } from "@/components/RawFileEditor";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { getFeatureFile, updateFeatureFile } from "@/lib/api";

export function FeatureFileDialog({ featureId, featureTitle, onSaved, renderTrigger }: {
    featureId: string;
    featureTitle: string;
    onSaved?: () => void;
    /** Custom trigger; defaults to a small ghost button. */
    renderTrigger?: (onClick: () => void) => React.ReactNode;
}) {
    const [open, setOpen] = useState(false);
    const [yaml, setYaml] = useState("");
    const [initialYaml, setInitialYaml] = useState("");
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");

    async function openDialog() {
        setOpen(true);
        setLoading(true);
        setError("");
        setYaml("");
        setInitialYaml("");
        try {
            const result = await getFeatureFile(featureId);
            const source = result.yaml ?? [
                `title: ${JSON.stringify(result.feature.title)}`,
                `description: ${JSON.stringify(result.feature.description)}`,
                "",
            ].join("\n");
            setYaml(source);
            setInitialYaml(result.yaml ?? "");
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    }

    function changeOpen(nextOpen: boolean) {
        if (saving) return;
        setOpen(nextOpen);
        if (!nextOpen) setError("");
    }

    async function save() {
        setSaving(true);
        setError("");
        try {
            await updateFeatureFile(featureId, yaml);
            setOpen(false);
            onSaved?.();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setSaving(false);
        }
    }

    return (
        <>
            {renderTrigger ? renderTrigger(() => void openDialog()) : (
                <Button type="button" variant="ghost" size="sm" onClick={openDialog} className="text-ink-muted">
                    <FileCog size={13} /> Edit source file
                </Button>
            )}
            <Dialog open={open} onOpenChange={changeOpen}>
                <DialogContent className="max-w-xl">
                    <DialogHeader>
                        <DialogTitle>Edit feature source</DialogTitle>
                        <DialogDescription>The feature file for {featureTitle}. It is saved and committed exactly as entered.</DialogDescription>
                    </DialogHeader>
                    {loading ? (
                        <div className="mt-5 space-y-2" aria-label="Loading feature file" aria-busy="true">
                            <Skeleton className="h-3 w-24" />
                            <Skeleton className="h-40 rounded-lg" />
                        </div>
                    ) : (
                        <form className="mt-5 space-y-4" onSubmit={(event) => { event.preventDefault(); void save(); }}>
                            <RawFileEditor id="feature-yaml" label="feature.yml" language="yaml" value={yaml} onChange={setYaml} disabled={saving} rows={8} />
                            {error && <Alert variant="danger" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
                            <DialogFooter className="pt-2">
                                <Button type="button" variant="outline" onClick={() => changeOpen(false)} disabled={saving}>Cancel</Button>
                                <Button type="submit" disabled={saving || !yaml.trim() || yaml === initialYaml}>{saving ? "Saving…" : "Save changes"}</Button>
                            </DialogFooter>
                        </form>
                    )}
                </DialogContent>
            </Dialog>
        </>
    );
}
