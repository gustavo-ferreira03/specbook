"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { KeyRound, PencilLine, Plus, Trash2, X } from "lucide-react";
import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { EmptyState } from "@/components/EmptyState";
import { InlineFeedback, SettingsBlock, SettingsSection } from "@/components/SettingsLayout";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
    createCredentialProfile,
    deleteCredentialProfile,
    listCredentialProfiles,
    updateCredentialProfile,
} from "@/lib/api";
import type { CredentialFieldInput, CredentialProfile } from "@/lib/types";

interface DraftField {
    key: string;
    value: string;
    hasValue: boolean;
}

function draftFromProfile(profile: CredentialProfile): DraftField[] {
    return profile.fields.map((field) => ({
        key: field.key,
        value: "",
        hasValue: field.hasValue,
    }));
}

export function CredentialProfilesCard({ projectId }: { projectId: string }) {
    const [profiles, setProfiles] = useState<CredentialProfile[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [formError, setFormError] = useState("");
    const [openId, setOpenId] = useState<string | "new" | null>(null);
    const [name, setName] = useState("");
    const [fields, setFields] = useState<DraftField[]>([]);
    const [identifier, setIdentifier] = useState("");
    const [saving, setSaving] = useState(false);
    const [deleteTarget, setDeleteTarget] = useState<CredentialProfile | null>(null);
    const [deleting, setDeleting] = useState(false);
    const [deleteError, setDeleteError] = useState("");
    const triggerRef = useRef<HTMLElement | null>(null);

    const refresh = useCallback(async () => {
        setLoading(true);
        setError("");
        try {
            setProfiles((await listCredentialProfiles(projectId)).profiles);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    }, [projectId]);

    useEffect(() => void refresh(), [refresh]);

    function openNew(trigger: HTMLElement) {
        triggerRef.current = trigger;
        setFormError("");
        setOpenId("new");
        setName("");
        setFields([
            { key: "email", value: "", hasValue: false },
            { key: "password", value: "", hasValue: false },
        ]);
    }

    function openEdit(profile: CredentialProfile, trigger: HTMLElement) {
        triggerRef.current = trigger;
        setFormError("");
        setOpenId(profile.id);
        setName(profile.name);
        setIdentifier(profile.identifier ?? "");
        setFields(draftFromProfile(profile));
    }

    async function save() {
        if (!name.trim()) {
            setFormError("Profile name is required.");
            return;
        }
        setSaving(true);
        setFormError("");
        const inputs: CredentialFieldInput[] = fields
            .filter((field) => field.key.trim())
            .map((field) => ({
                key: field.key.trim(),
                value: field.value === "" && field.hasValue ? undefined : field.value,
            }));
        try {
            if (openId === "new") await createCredentialProfile(projectId, { name: name.trim(), fields: inputs });
            else if (openId) await updateCredentialProfile(openId, { fields: inputs, ...(editing?.identifier != null ? { identifier: identifier.trim() } : {}) });
            setOpenId(null);
            await refresh();
        } catch (err) {
            setFormError(err instanceof Error ? err.message : typeof err === "object" && err !== null ? JSON.stringify(err) : String(err));
        } finally {
            setSaving(false);
        }
    }

    async function confirmRemove() {
        if (!deleteTarget) return;
        setDeleting(true);
        setDeleteError("");
        try {
            await deleteCredentialProfile(deleteTarget.id);
            setDeleteTarget(null);
            await refresh();
        } catch (err) {
            setDeleteError(err instanceof Error ? err.message : String(err));
        } finally {
            setDeleting(false);
        }
    }

    const editing = openId !== null && openId !== "new" ? profiles.find((profile) => profile.id === openId) : undefined;

    return (
        <>
            <SettingsSection
                id="credentials-heading"
                title="Credentials"
                description="Login profiles the agent can use. Passwords and other fields are encrypted and never shown again once saved; a login saved from a chat keeps its username visible so the agent can type it."
                actions={profiles.length > 0 &&
                    <Button type="button" variant="outline" onClick={(event) => openNew(event.currentTarget)}>
                        <Plus size={14} /> New profile
                    </Button>
                }
            >
                {error && (
                    <SettingsBlock>
                        <InlineFeedback feedback={{ type: "error", text: error }} />
                    </SettingsBlock>
                )}
                {loading && profiles.length === 0 && (
                    <div aria-label="Loading credential profiles" aria-busy="true" role="status">
                        {[0, 1].map((row) => (
                            <SettingsBlock key={row} className="flex items-center gap-3">
                                <Skeleton className="size-8 rounded-full" />
                                <div className="flex-1 space-y-1.5"><Skeleton className="h-4 w-32" /><Skeleton className="h-3 w-48" /></div>
                            </SettingsBlock>
                        ))}
                    </div>
                )}
                {!loading && profiles.length === 0 && !error && (
                    <EmptyState
                        size="compact"
                        icon={KeyRound}
                        title="No credential profiles yet"
                        description="Add a login so the agent can sign in while it explores and verifies."
                        action={<Button type="button" size="sm" onClick={(event) => openNew(event.currentTarget)}><Plus size={14} /> New profile</Button>}
                        className="py-10"
                    />
                )}
                {profiles.length > 0 && (
                    <ul>
                        {profiles.map((profile) => (
                            <li key={profile.id} className="group relative flex min-h-16 items-center gap-3 border-b border-line px-4 py-3 transition-colors last:border-0 hover:bg-surface-soft sm:px-5">
                                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-hover text-ink-muted">
                                    <KeyRound size={15} aria-hidden="true" />
                                </span>
                                <div className="min-w-0 flex-1">
                                    <button
                                        type="button"
                                        onClick={(event) => openEdit(profile, event.currentTarget)}
                                        className="block max-w-full truncate rounded-sm text-left text-control font-medium text-ink outline-none after:absolute after:inset-0 focus-visible:ring-2 focus-visible:ring-ring"
                                    >
                                        {profile.name}
                                    </button>
                                    <p className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-meta text-ink-subtle">
                                        {profile.identifier !== null && (
                                            <span className="inline-flex min-w-0 items-center gap-1">
                                                <span className="font-mono">username</span>
                                                <span className="truncate">{profile.identifier}</span>
                                            </span>
                                        )}
                                        {profile.fields.length === 0 && profile.identifier !== null ? null : profile.fields.length === 0 ? "No fields" : profile.fields.map((field) => (
                                            <span key={field.key} className="inline-flex items-center gap-1">
                                                <span className="font-mono">{field.key}</span>
                                                <span aria-label={field.hasValue ? "saved" : "empty"}>{field.hasValue ? "••••" : "empty"}</span>
                                            </span>
                                        ))}
                                    </p>
                                </div>
                                <div className="relative z-10 flex shrink-0 items-center gap-1">
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <Button type="button" size="icon-sm" variant="ghost" aria-label={`Edit ${profile.name}`} onClick={(event) => openEdit(profile, event.currentTarget)}>
                                                <PencilLine size={14} />
                                            </Button>
                                        </TooltipTrigger>
                                        <TooltipContent>Edit</TooltipContent>
                                    </Tooltip>
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <Button
                                                type="button"
                                                size="icon-sm"
                                                variant="ghost"
                                                aria-label={`Delete ${profile.name}`}
                                                className="hover:bg-danger-soft hover:text-danger"
                                                onClick={(event) => {
                                                    triggerRef.current = event.currentTarget;
                                                    setDeleteError("");
                                                    setDeleteTarget(profile);
                                                }}
                                            >
                                                <Trash2 size={14} />
                                            </Button>
                                        </TooltipTrigger>
                                        <TooltipContent>Delete</TooltipContent>
                                    </Tooltip>
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </SettingsSection>

            <Dialog open={openId !== null} onOpenChange={(open) => { if (!open && !saving) setOpenId(null); }}>
                <DialogContent
                    className="max-w-xl"
                    onCloseAutoFocus={(event) => {
                        const trigger = triggerRef.current;
                        if (!trigger?.isConnected) return;
                        event.preventDefault();
                        trigger.focus();
                    }}
                >
                    <DialogHeader>
                        <DialogTitle>{openId === "new" ? "New credential profile" : `Edit ${editing?.name ?? "profile"}`}</DialogTitle>
                        <DialogDescription>
                            {openId === "new" ? "Values are encrypted when saved and never shown again." : "Leave a saved value blank to keep it. The profile name cannot be changed."}
                        </DialogDescription>
                    </DialogHeader>
                    <form
                        className="mt-5 space-y-5"
                        onSubmit={(event) => {
                            event.preventDefault();
                            void save();
                        }}
                    >
                        <div>
                            <Label htmlFor="credential-name" className="mb-1.5">Profile name</Label>
                            <Input
                                id="credential-name"
                                value={name}
                                disabled={openId !== "new"}
                                onChange={(event) => setName(event.target.value)}
                                placeholder="admin"
                                autoComplete="off"
                            />
                        </div>
                        {editing?.identifier != null && (
                            <div>
                                <Label htmlFor="credential-identifier" className="mb-1.5">Username</Label>
                                <Input
                                    id="credential-identifier"
                                    value={identifier}
                                    onChange={(event) => setIdentifier(event.target.value)}
                                    autoComplete="off"
                                />
                                <p className="mt-1 text-meta text-ink-subtle">Not encrypted: the agent sees it and types it. Specs use it as secret(&quot;{editing.name}&quot;, &quot;username&quot;).</p>
                            </div>
                        )}
                        <fieldset className="min-w-0">
                            <legend className="mb-1.5 text-control font-medium text-ink">Fields</legend>
                            <div className="space-y-2">
                                {fields.length > 0 && (
                                    <div className="hidden grid-cols-[10rem_minmax(0,1fr)_2rem] gap-2 text-meta text-ink-subtle sm:grid" aria-hidden="true">
                                        <span>Name</span><span>Value</span><span />
                                    </div>
                                )}
                                {fields.map((field, index) => (
                                    <div key={index} className="grid grid-cols-[minmax(0,1fr)_2rem] gap-2 sm:grid-cols-[10rem_minmax(0,1fr)_2rem]">
                                        <Input
                                            value={field.key}
                                            aria-label={`Field ${index + 1} name`}
                                            placeholder="field"
                                            className="font-mono text-meta"
                                            autoComplete="off"
                                            onChange={(event) =>
                                                setFields(fields.map((f, i) => (i === index ? { ...f, key: event.target.value } : f)))
                                            }
                                        />
                                        <Input
                                            type="password"
                                            autoComplete="off"
                                            aria-label={`${field.key || `Field ${index + 1}`} value`}
                                            value={field.value}
                                            placeholder={field.hasValue ? "Saved (leave blank to keep)" : "Value"}
                                            className="col-start-1 row-start-2 sm:col-start-auto sm:row-start-auto"
                                            onChange={(event) =>
                                                setFields(fields.map((f, i) => (i === index ? { ...f, value: event.target.value } : f)))
                                            }
                                        />
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon"
                                            onClick={() => setFields(fields.filter((_, i) => i !== index))}
                                            className="col-start-2 row-start-1 size-9 hover:bg-danger-soft hover:text-danger sm:col-start-auto sm:row-start-auto"
                                            aria-label={`Remove ${field.key || "field"}`}
                                        >
                                            <X size={14} />
                                        </Button>
                                    </div>
                                ))}
                                <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    className="-ml-1"
                                    onClick={() => setFields([...fields, { key: "", value: "", hasValue: false }])}
                                >
                                    <Plus size={14} /> Add field
                                </Button>
                            </div>
                        </fieldset>
                        {formError && <InlineFeedback feedback={{ type: "error", text: formError }} />}
                        <DialogFooter className="border-t border-line pt-4">
                            <Button type="button" variant="outline" onClick={() => setOpenId(null)} disabled={saving}>Cancel</Button>
                            <Button type="submit" disabled={saving}>{saving ? "Saving…" : openId === "new" ? "Create profile" : "Save changes"}</Button>
                        </DialogFooter>
                    </form>
                </DialogContent>
            </Dialog>

            <ConfirmDeleteDialog
                open={deleteTarget !== null}
                title="Delete credential profile?"
                description={<><strong className="font-semibold text-ink">{deleteTarget?.name}</strong> and its encrypted values are removed. The agent can no longer use it to sign in.</>}
                confirmLabel="Delete profile"
                busy={deleting}
                error={deleteError}
                returnFocusRef={triggerRef}
                onCancel={() => {
                    setDeleteTarget(null);
                    setDeleteError("");
                }}
                onConfirm={() => void confirmRemove()}
            />
        </>
    );
}
