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
            <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
                <FolderPlus size={13} /> New Feature
            </Button>
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="max-w-sm">
                    <DialogHeader>
                        <DialogTitle>New Feature</DialogTitle>
                        <DialogDescription>Creates a directory with a feature.yml and commits it.</DialogDescription>
                    </DialogHeader>
                    {error && <Alert variant="destructive" className="text-xs" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
                    <div className="space-y-3">
                        <div className="space-y-1">
                            <Label htmlFor="new-feature-title">Title</Label>
                            <Input id="new-feature-title" value={title} onChange={(event) => setTitle(event.target.value)} disabled={busy} />
                        </div>
                        <div className="space-y-1">
                            <Label>Parent feature</Label>
                            <Select value={parentId} onValueChange={setParentId}>
                                <SelectTrigger className="w-full" aria-label="Parent feature">
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
                    </div>
                    <DialogFooter className="mt-4">
                        <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
                        <Button type="button" onClick={create} disabled={busy || !title.trim()}>{busy ? "Creating..." : "Create"}</Button>
                    </DialogFooter>
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
            <Button type="button" size="sm" onClick={() => setOpen(true)} disabled={features.length === 0}>
                <FilePlus2 size={13} /> New Spec
            </Button>
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="max-w-sm">
                    <DialogHeader>
                        <DialogTitle>New Spec</DialogTitle>
                        <DialogDescription>Creates a spec.yml + spec.robot skeleton you can edit by hand.</DialogDescription>
                    </DialogHeader>
                    {error && <Alert variant="destructive" className="text-xs" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
                    <div className="space-y-3">
                        <div className="space-y-1">
                            <Label htmlFor="new-spec-title">Title</Label>
                            <Input id="new-spec-title" value={title} onChange={(event) => setTitle(event.target.value)} disabled={busy} />
                        </div>
                        <div className="space-y-1">
                            <Label>Feature</Label>
                            <Select value={featureId} onValueChange={setFeatureId}>
                                <SelectTrigger className="w-full" aria-label="Feature">
                                    <SelectValue placeholder="Choose a feature" />
                                </SelectTrigger>
                                <SelectContent>
                                    {features.map((feature) => (
                                        <SelectItem key={feature.id} value={feature.id}>{featureLabel(feature)}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    </div>
                    <DialogFooter className="mt-4">
                        <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
                        <Button type="button" onClick={create} disabled={busy || !title.trim() || !featureId}>{busy ? "Creating..." : "Create"}</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
