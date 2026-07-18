"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { FilePlus2, FolderPlus } from "lucide-react";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { createFeature, createManualSpec } from "@/lib/api";
import type { Feature } from "@/lib/types";

const ROOT_VALUE = "__root__";

function featureLabel(feature: Feature): string {
    return feature.path.replace(/^specs\//, "").split("/").join(" / ");
}

export function NewFeatureDialog({ projectId, features, onCreated }: {
    projectId: string;
    features: Feature[];
    onCreated: () => void;
}) {
    const [open, setOpen] = useState(false);
    const [title, setTitle] = useState("");
    const [parentId, setParentId] = useState(ROOT_VALUE);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    function changeOpen(nextOpen: boolean) {
        if (busy) return;
        setOpen(nextOpen);
        if (!nextOpen) setError("");
    }

    async function create() {
        setBusy(true);
        setError("");
        try {
            await createFeature(projectId, {
                title: title.trim(),
                parentId: parentId === ROOT_VALUE ? undefined : parentId,
            });
            setOpen(false);
            setTitle("");
            setParentId(ROOT_VALUE);
            onCreated();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    return (
        <>
            <Button type="button" variant="outline" size="sm" onClick={() => changeOpen(true)}>
                <FolderPlus size={13} /> New Feature
            </Button>
            <Dialog open={open} onOpenChange={changeOpen}>
                <DialogContent className="max-w-[400px]">
                    <DialogHeader className="pr-8">
                        <DialogTitle>New Feature</DialogTitle>
                        <DialogDescription>Create a repository directory and its feature.yml file.</DialogDescription>
                    </DialogHeader>
                    {error && <Alert variant="destructive" className="mt-4" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
                    <form className="mt-5 space-y-4" onSubmit={(event) => { event.preventDefault(); void create(); }}>
                        <div className="space-y-1.5">
                            <Label htmlFor="new-feature-title">Title</Label>
                            <Input id="new-feature-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Checkout" disabled={busy} />
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="new-feature-parent">Parent Feature</Label>
                            <Select value={parentId} onValueChange={setParentId}>
                                <SelectTrigger id="new-feature-parent" className="w-full" aria-label="Parent Feature">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value={ROOT_VALUE}>No parent (top level)</SelectItem>
                                    {features.map((feature) => (
                                        <SelectItem key={feature.id} value={feature.id}>{featureLabel(feature)}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <DialogFooter className="pt-1">
                            <Button type="button" variant="outline" onClick={() => changeOpen(false)} disabled={busy}>Cancel</Button>
                            <Button type="submit" disabled={busy || !title.trim()}>{busy ? "Creating..." : "Create Feature"}</Button>
                        </DialogFooter>
                    </form>
                </DialogContent>
            </Dialog>
        </>
    );
}

export function NewSpecDialog({ projectId, features }: { projectId: string; features: Feature[] }) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [title, setTitle] = useState("");
    const [featureId, setFeatureId] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    function changeOpen(nextOpen: boolean) {
        if (busy) return;
        setOpen(nextOpen);
        if (!nextOpen) setError("");
    }

    async function create() {
        setBusy(true);
        setError("");
        try {
            const { spec } = await createManualSpec(projectId, featureId, title.trim());
            setOpen(false);
            router.push(`/p/${projectId}/specs/${spec.id}`);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    return (
        <>
            <Button type="button" size="sm" onClick={() => changeOpen(true)} disabled={features.length === 0}>
                <FilePlus2 size={13} /> New Spec
            </Button>
            <Dialog open={open} onOpenChange={changeOpen}>
                <DialogContent className="max-w-[400px]">
                    <DialogHeader className="pr-8">
                        <DialogTitle>New Spec</DialogTitle>
                        <DialogDescription>Create spec.yml and spec.robot files inside the selected Feature.</DialogDescription>
                    </DialogHeader>
                    {error && <Alert variant="destructive" className="mt-4" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
                    <form className="mt-5 space-y-4" onSubmit={(event) => { event.preventDefault(); void create(); }}>
                        <div className="space-y-1.5">
                            <Label htmlFor="new-spec-title">Title</Label>
                            <Input id="new-spec-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Guest checkout" disabled={busy} />
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="new-spec-feature">Feature</Label>
                            <Select value={featureId} onValueChange={setFeatureId}>
                                <SelectTrigger id="new-spec-feature" className="w-full" aria-label="Feature">
                                    <SelectValue placeholder="Choose a feature" />
                                </SelectTrigger>
                                <SelectContent>
                                    {features.map((feature) => (
                                        <SelectItem key={feature.id} value={feature.id}>{featureLabel(feature)}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <DialogFooter className="pt-1">
                            <Button type="button" variant="outline" onClick={() => changeOpen(false)} disabled={busy}>Cancel</Button>
                            <Button type="submit" disabled={busy || !title.trim() || !featureId}>{busy ? "Creating..." : "Create Spec"}</Button>
                        </DialogFooter>
                    </form>
                </DialogContent>
            </Dialog>
        </>
    );
}
