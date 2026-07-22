"use client";

import { useState } from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { updateFeature } from "@/lib/api";
import type { Feature } from "@/lib/types";

export function FeatureEditDialog({ feature, onSaved, renderTrigger }: {
    feature: Feature;
    onSaved?: () => void;
    renderTrigger: (onClick: () => void) => React.ReactNode;
}) {
    const [open, setOpen] = useState(false);
    const [title, setTitle] = useState(feature.title);
    const [description, setDescription] = useState(feature.description);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");

    function openDialog() {
        setTitle(feature.title);
        setDescription(feature.description);
        setError("");
        setOpen(true);
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
            await updateFeature(feature.id, { title: title.trim(), description });
            setOpen(false);
            onSaved?.();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setSaving(false);
        }
    }

    const dirty = title.trim() !== feature.title || description !== feature.description;

    return (
        <>
            {renderTrigger(openDialog)}
            <Dialog open={open} onOpenChange={changeOpen}>
                <DialogContent className="max-w-[400px]">
                    <DialogHeader className="pr-8">
                        <DialogTitle>Edit feature</DialogTitle>
                        <DialogDescription>Update the name and description of this feature.</DialogDescription>
                    </DialogHeader>
                    {error && <Alert variant="destructive" className="mt-4" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
                    <form className="mt-5 space-y-4" onSubmit={(event) => { event.preventDefault(); void save(); }}>
                        <div className="space-y-1.5">
                            <Label htmlFor="edit-feature-title">Title</Label>
                            <Input id="edit-feature-title" value={title} onChange={(event) => setTitle(event.target.value)} disabled={saving} />
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="edit-feature-description">Description</Label>
                            <Textarea id="edit-feature-description" value={description} onChange={(event) => setDescription(event.target.value)} disabled={saving} rows={4} />
                        </div>
                        <DialogFooter className="pt-1">
                            <Button type="button" variant="outline" onClick={() => changeOpen(false)} disabled={saving}>Cancel</Button>
                            <Button type="submit" disabled={saving || !title.trim() || !dirty}>{saving ? "Saving..." : "Save changes"}</Button>
                        </DialogFooter>
                    </form>
                </DialogContent>
            </Dialog>
        </>
    );
}
