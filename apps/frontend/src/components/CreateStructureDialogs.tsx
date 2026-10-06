"use client";

import { useAuth } from "@/components/AuthProvider";
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
    const { canEdit } = useAuth();
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

    if (!canEdit) return null;
    return (
        <>
            <Button type="button" variant="outline" size="sm" onClick={() => changeOpen(true)}>
                <FolderPlus size={13} /> New Feature
            </Button>
            <Dialog open={open} onOpenChange={changeOpen}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>New feature</DialogTitle>
                        <DialogDescription>Group related Specs under an area of the product, such as Checkout or Search.</DialogDescription>
                    </DialogHeader>
                    <form className="mt-5 space-y-4" onSubmit={(event) => { event.preventDefault(); void create(); }}>
                        <div className="space-y-1.5">
                            <Label htmlFor="new-feature-title">Title</Label>
                            <Input id="new-feature-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Checkout" disabled={busy} />
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="new-feature-parent">Parent feature</Label>
                            <Select value={parentId} onValueChange={setParentId}>
                                <SelectTrigger id="new-feature-parent" className="w-full" aria-label="Parent feature">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value={ROOT_VALUE}>No parent (top level)</SelectItem>
                                    {features.map((feature) => (
                                        <SelectItem key={feature.id} value={feature.id}>{featureLabel(feature)}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            <p className="text-meta text-ink-subtle">Nest it inside another feature, or keep it at the top level.</p>
                        </div>
                        {error && <Alert variant="danger" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
                        <DialogFooter className="pt-2">
                            <Button type="button" variant="outline" onClick={() => changeOpen(false)} disabled={busy}>Cancel</Button>
                            <Button type="submit" disabled={busy || !title.trim()}>{busy ? "Creating…" : "Create feature"}</Button>
                        </DialogFooter>
                    </form>
                </DialogContent>
            </Dialog>
        </>
    );
}

export function NewSpecDialog({ projectId, features }: { projectId: string; features: Feature[] }) {
    const router = useRouter();
    const { canEdit } = useAuth();
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

    if (!canEdit) return null;
    return (
        <>
            <Button type="button" variant="outline" size="sm" onClick={() => changeOpen(true)} disabled={features.length === 0} title={features.length === 0 ? "Create a feature first" : undefined}>
                <FilePlus2 size={13} /> New Spec
            </Button>
            <Dialog open={open} onOpenChange={changeOpen}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>New Spec</DialogTitle>
                        <DialogDescription>Start an empty Spec inside a feature, then fill in its steps. To have the agent write it, describe the behavior in a chat instead.</DialogDescription>
                    </DialogHeader>
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
                        {error && <Alert variant="danger" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
                        <DialogFooter className="pt-2">
                            <Button type="button" variant="outline" onClick={() => changeOpen(false)} disabled={busy}>Cancel</Button>
                            <Button type="submit" disabled={busy || !title.trim() || !featureId}>{busy ? "Creating…" : "Create Spec"}</Button>
                        </DialogFooter>
                    </form>
                </DialogContent>
            </Dialog>
        </>
    );
}
