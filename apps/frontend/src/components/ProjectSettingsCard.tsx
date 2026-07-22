"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Settings2, Trash2 } from "lucide-react";
import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { api, deleteProject, updateProject } from "@/lib/api";
import type { Project } from "@/lib/types";

export function ProjectSettingsCard({ projectId }: { projectId: string }) {
    const router = useRouter();
    const [project, setProject] = useState<Project | null>(null);
    const [name, setName] = useState("");
    const [baseUrl, setBaseUrl] = useState("");
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const [deleteOpen, setDeleteOpen] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [deleteError, setDeleteError] = useState("");
    const deleteTriggerRef = useRef<HTMLElement | null>(null);

    const refresh = useCallback(async () => {
        setLoading(true);
        setError("");
        try {
            const result = await api<{ project: Project }>(`/projects/${projectId}`);
            setProject(result.project);
            setName(result.project.name);
            setBaseUrl(result.project.baseUrl);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    }, [projectId]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const dirty = project !== null && (name.trim() !== project.name || baseUrl.trim() !== project.baseUrl);

    async function save() {
        setSaving(true);
        setError("");
        try {
            const result = await updateProject(projectId, { name: name.trim(), baseUrl: baseUrl.trim() });
            setProject(result.project);
            setName(result.project.name);
            setBaseUrl(result.project.baseUrl);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setSaving(false);
        }
    }

    async function confirmDelete() {
        setDeleting(true);
        setDeleteError("");
        try {
            await deleteProject(projectId);
            router.push("/");
        } catch (err) {
            setDeleteError(err instanceof Error ? err.message : String(err));
            setDeleting(false);
        }
    }

    return (
        <section className="space-y-3" aria-labelledby="project-settings-heading">
            <div className="flex items-center gap-2">
                <Settings2 className="size-4" aria-hidden />
                <h2 id="project-settings-heading" className="text-[0.8125rem] font-bold">Project</h2>
            </div>
            <p className="max-w-[68ch] text-[0.65625rem] leading-5 text-ink-faint">
                The name and base URL used across this project.
            </p>
            {error && (
                <Alert variant="destructive">
                    <AlertCircle className="size-4" aria-hidden />
                    <AlertTitle>Could not save project</AlertTitle>
                    <AlertDescription>{error}</AlertDescription>
                </Alert>
            )}
            {loading && (
                <div className="space-y-2" aria-label="Loading project settings" aria-busy="true">
                    <Skeleton className="h-9 rounded-lg" />
                    <Skeleton className="h-9 rounded-lg" />
                </div>
            )}
            {!loading && project && (
                <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void save(); }}>
                    <div className="grid gap-3 sm:grid-cols-2">
                        <div className="space-y-1.5">
                            <Label htmlFor="project-name">Project name</Label>
                            <Input id="project-name" value={name} onChange={(event) => setName(event.target.value)} disabled={saving} />
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="project-base-url">Base URL</Label>
                            <Input id="project-base-url" type="url" inputMode="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://staging.example.com" disabled={saving} />
                        </div>
                    </div>
                    {dirty && (
                        <div className="flex flex-wrap justify-end gap-2">
                            <Button type="button" size="sm" variant="outline" onClick={() => { setName(project.name); setBaseUrl(project.baseUrl); setError(""); }} disabled={saving}>Cancel</Button>
                            <Button type="submit" size="sm" disabled={saving || !name.trim() || !baseUrl.trim()}>{saving ? "Saving..." : "Save changes"}</Button>
                        </div>
                    )}
                </form>
            )}

            {!loading && project && (
                <div className="space-y-2 rounded-lg border border-line-strong p-4">
                    <h3 className="text-[0.71875rem] font-bold">Delete project</h3>
                    <p className="max-w-[68ch] text-[0.65625rem] leading-5 text-ink-faint">
                        Permanently removes every Feature, Spec, run, chat, and credential in this project, along with its repository. This cannot be undone.
                    </p>
                    <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        onClick={(event) => {
                            deleteTriggerRef.current = event.currentTarget;
                            setDeleteError("");
                            setDeleteOpen(true);
                        }}
                    >
                        <Trash2 size={13} /> Delete project
                    </Button>
                </div>
            )}

            {project && (
                <ConfirmDeleteDialog
                    open={deleteOpen}
                    title="Delete project?"
                    description={<>
                        <strong className="font-bold text-ink">{project.name}</strong> and everything in it will be permanently removed: every Feature, Spec, run history, evidence, chat, and saved credential. The local repository is deleted too. A connected GitHub remote is left untouched.
                    </>}
                    confirmLabel="Delete project"
                    busy={deleting}
                    error={deleteError}
                    returnFocusRef={deleteTriggerRef}
                    onCancel={() => {
                        setDeleteOpen(false);
                        setDeleteError("");
                    }}
                    onConfirm={() => void confirmDelete()}
                />
            )}
        </section>
    );
}
