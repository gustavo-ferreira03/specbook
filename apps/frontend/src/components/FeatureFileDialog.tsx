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
import { getFeatureFile, updateFeatureFile } from "@/lib/api";

export function FeatureFileDialog({ featureId, featureTitle, onSaved }: {
    featureId: string;
    featureTitle: string;
    onSaved?: () => void;
}) {
    const [open, setOpen] = useState(false);
    const [yaml, setYaml] = useState("");
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");

    async function openDialog() {
        setOpen(true);
        setLoading(true);
        setError("");
        try {
            const result = await getFeatureFile(featureId);
            setYaml(result.yaml ?? "");
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
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
            <Button type="button" variant="ghost" size="sm" onClick={openDialog} className="text-ink-soft">
                <FileCog size={12} /> feature.yml
            </Button>
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="max-w-lg">
                    <DialogHeader>
                        <DialogTitle>Edit feature.yml</DialogTitle>
                        <DialogDescription>{featureTitle} — saving commits exactly what you type.</DialogDescription>
                    </DialogHeader>
                    {error && <Alert variant="destructive" className="text-xs" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
                    <RawFileEditor id="feature-yaml" label="feature.yml" language="yaml" value={yaml} onChange={setYaml} disabled={loading || saving} rows={8} />
                    <DialogFooter className="mt-3">
                        <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
                        <Button type="button" onClick={save} disabled={loading || saving}>{saving ? "Saving..." : "Save"}</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
