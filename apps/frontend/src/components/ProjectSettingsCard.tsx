"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, Trash2 } from "lucide-react";
import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { InlineFeedback, SettingsBlock, SettingsFooter, SettingsRow, SettingsSection } from "@/components/SettingsLayout";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { deleteProject, getProject, updateProject } from "@/lib/api";
import type { Project } from "@/lib/types";

export function ProjectSettingsCard({ projectId }: { projectId: string }) {
    const router = useRouter();
    const [project, setProject] = useState<Project | null>(null);
    const [name, setName] = useState("");
    const [baseUrl, setBaseUrl] = useState("");
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const [saved, setSaved] = useState(false);
    const [deleteOpen, setDeleteOpen] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [deleteError, setDeleteError] = useState("");
    const deleteTriggerRef = useRef<HTMLElement | null>(null);

    const refresh = useCallback(async () => {
        setLoading(true);
        setError("");
        try {
            const result = await getProject(projectId);
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
        setSaved(false);
        try {
            const result = await updateProject(projectId, { name: name.trim(), baseUrl: baseUrl.trim() });
            setProject(result.project);
            setName(result.project.name);
            setBaseUrl(result.project.baseUrl);
            setSaved(true);
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
        <div className="space-y-10">
            <SettingsSection id="project-settings-heading" title="Project" description="The project name and default Production address.">
                {loading && (
                    <div aria-label="Loading project settings" aria-busy="true" role="status">
                        {[0, 1].map((row) => (
                            <SettingsBlock key={row} className="grid gap-3 md:grid-cols-[13rem_1fr] md:gap-8">
                                <Skeleton className="h-4 w-24 md:mt-2.5" />
                                <Skeleton className="h-9" />
                            </SettingsBlock>
                        ))}
                    </div>
                )}
                {!loading && !project && error && (
                    <SettingsBlock>
                        <Alert variant="danger" role="alert">
                            <AlertTitle>Project settings could not load</AlertTitle>
                            <AlertDescription>{error}</AlertDescription>
                        </Alert>
                        <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => void refresh()}>
                            <RefreshCw size={14} /> Try again
                        </Button>
                    </SettingsBlock>
                )}
                {!loading && project && (
                    <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
                        <SettingsRow label="Project name" htmlFor="project-name">
                            <Input id="project-name" value={name} onChange={(event) => { setName(event.target.value); setSaved(false); }} disabled={saving} autoComplete="off" />
                        </SettingsRow>
                        <SettingsRow label="Production URL" htmlFor="project-base-url">
                            <Input id="project-base-url" type="url" inputMode="url" value={baseUrl} onChange={(event) => { setBaseUrl(event.target.value); setSaved(false); }} placeholder="https://staging.example.com" disabled={saving} className="font-mono text-meta" aria-describedby="project-base-url-help" />
                            <p id="project-base-url-help" className="mt-1.5 text-meta text-ink-subtle">Use an address the self-hosted runtime can reach. Chats start here. Add other destinations in Environments.</p>
                        </SettingsRow>
                        <SettingsFooter
                            feedback={error ? <InlineFeedback feedback={{ type: "error", text: error }} /> : saved && !dirty ? <InlineFeedback feedback={{ type: "success", text: "Project saved." }} /> : dirty ? <span className="text-control text-ink-muted">Unsaved changes</span> : null}
                        >
                            {dirty && <Button type="button" variant="ghost" onClick={() => { setName(project.name); setBaseUrl(project.baseUrl); setError(""); }} disabled={saving}>Cancel</Button>}
                            <Button type="submit" disabled={saving || !dirty || !name.trim() || !baseUrl.trim()}>{saving ? "Saving…" : "Save changes"}</Button>
                        </SettingsFooter>
                    </form>
                )}
            </SettingsSection>

            {!loading && project && (
                <SettingsSection id="danger-zone-heading" title="Danger zone" tone="danger">
                    <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:px-5">
                        <div className="min-w-0">
                            <p className="text-control font-medium text-ink">Delete this project</p>
                            <p className="mt-0.5 max-w-[60ch] text-meta text-ink-muted">
                                Permanently removes every Feature, Spec, run, chat, and credential in this project, along with its repository. This cannot be undone.
                            </p>
                        </div>
                        <Button
                            type="button"
                            variant="destructive-soft"
                            className="self-start sm:self-auto"
                            onClick={(event) => {
                                deleteTriggerRef.current = event.currentTarget;
                                setDeleteError("");
                                setDeleteOpen(true);
                            }}
                        >
                            <Trash2 size={14} /> Delete project
                        </Button>
                    </div>
                </SettingsSection>
            )}

            {project && (
                <ConfirmDeleteDialog
                    open={deleteOpen}
                    title="Delete project?"
                    description={<>
                        <strong className="font-semibold text-ink">{project.name}</strong> and everything in it will be permanently removed: every Feature, Spec, run history, evidence, chat, and saved credential. The local repository is deleted too.
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
        </div>
    );
}
