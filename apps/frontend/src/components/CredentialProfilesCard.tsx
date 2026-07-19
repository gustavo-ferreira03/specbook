"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, KeyRound, Lock, Plus, Trash2, Unlock, X } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    createCredentialProfile,
    deleteCredentialProfile,
    listCredentialProfiles,
    updateCredentialProfile,
} from "@/lib/api";
import type { CredentialFieldInput, CredentialProfile } from "@/lib/types";

interface DraftField {
    key: string;
    secret: boolean;
    value: string;
    hasValue: boolean;
}

function draftFromProfile(profile: CredentialProfile): DraftField[] {
    return profile.fields.map((field) => ({
        key: field.key,
        secret: field.secret,
        value: field.secret ? "" : (field.value ?? ""),
        hasValue: field.hasValue,
    }));
}

export function CredentialProfilesCard({ projectId }: { projectId: string }) {
    const [profiles, setProfiles] = useState<CredentialProfile[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [openId, setOpenId] = useState<string | "new" | null>(null);
    const [name, setName] = useState("");
    const [fields, setFields] = useState<DraftField[]>([]);
    const [saving, setSaving] = useState(false);

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

    function openNew() {
        setOpenId("new");
        setName("");
        setFields([
            { key: "email", secret: false, value: "", hasValue: false },
            { key: "password", secret: true, value: "", hasValue: false },
        ]);
    }

    function openEdit(profile: CredentialProfile) {
        setOpenId(profile.id);
        setName(profile.name);
        setFields(draftFromProfile(profile));
    }

    async function save() {
        if (!name.trim()) {
            setError("Profile name is required.");
            return;
        }
        setSaving(true);
        setError("");
        const inputs: CredentialFieldInput[] = fields
            .filter((field) => field.key.trim())
            .map((field) => ({
                key: field.key.trim(),
                secret: field.secret,
                value: field.secret && field.value === "" && field.hasValue ? undefined : field.value,
            }));
        try {
            if (openId === "new") await createCredentialProfile(projectId, { name: name.trim(), fields: inputs });
            else if (openId) await updateCredentialProfile(openId, { fields: inputs });
            setOpenId(null);
            await refresh();
        } catch (err) {
            setError(err instanceof Error ? err.message : typeof err === "object" && err !== null ? JSON.stringify(err) : String(err));
        } finally {
            setSaving(false);
        }
    }

    async function remove(profileId: string) {
        setError("");
        try {
            await deleteCredentialProfile(profileId);
            await refresh();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }

    return (
        <section className="space-y-3" aria-labelledby="credentials-heading">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <KeyRound className="size-4" aria-hidden />
                    <h2 id="credentials-heading" className="text-[0.8125rem] font-bold">Credentials</h2>
                </div>
                {openId === null && (
                    <Button type="button" size="sm" variant="outline" onClick={openNew}>
                        <Plus size={13} /> New profile
                    </Button>
                )}
            </div>
            <p className="max-w-[68ch] text-[0.65625rem] leading-5 text-ink-faint">
                Login profiles the agent can use. Secret values are encrypted and never shown again once saved.
            </p>
            {error && (
                <Alert variant="destructive">
                    <AlertCircle className="size-4" aria-hidden />
                    <AlertTitle>Credential error</AlertTitle>
                    <AlertDescription>{error}</AlertDescription>
                </Alert>
            )}
            {!loading && profiles.length === 0 && openId === null && (
                <p className="text-[0.6875rem] text-ink-faint">No credential profiles yet.</p>
            )}
            <div className="grid gap-2 empty:hidden">
                {profiles.map((profile) => (
                    <div
                        key={profile.id}
                        className="group flex items-start gap-3 rounded-[9px] border border-line-strong bg-surface p-3 transition-colors hover:bg-surface-hover cursor-pointer"
                        onClick={() => openEdit(profile)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openEdit(profile); } }}
                    >
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                                <span className="size-2 rounded-full bg-success shrink-0" />
                                <p className="truncate text-[0.71875rem] font-bold">{profile.name}</p>
                            </div>
                            <p className="mt-1 truncate text-[0.625rem] text-ink-faint">
                                {profile.fields.map((field) => (field.secret ? `${field.key}: ••••` : `${field.key}: ${field.value}`)).join("  ·  ")}
                            </p>
                        </div>
                        <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            aria-label={`Delete ${profile.name}`}
                            onClick={(e) => { e.stopPropagation(); void remove(profile.id); }}
                            className="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
                        >
                            <Trash2 size={13} />
                        </Button>
                    </div>
                ))}
            </div>
            {openId && (
                <form
                    className="space-y-3 rounded-[9px] border border-line-strong bg-surface-soft p-4"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void save();
                    }}
                >
                    <div>
                        <Label htmlFor="credential-name">Profile name</Label>
                        <Input
                            id="credential-name"
                            value={name}
                            disabled={openId !== "new"}
                            onChange={(event) => setName(event.target.value)}
                            placeholder="admin"
                        />
                    </div>
                    {fields.map((field, index) => (
                        <div key={index} className="flex items-end gap-2">
                            <div className="w-40">
                                <Label className="text-[0.625rem]">Field</Label>
                                <Input
                                    value={field.key}
                                    onChange={(event) =>
                                        setFields(fields.map((f, i) => (i === index ? { ...f, key: event.target.value } : f)))
                                    }
                                />
                            </div>
                            <div className="flex-1">
                                <Label className="text-[0.625rem]">{field.secret ? "Secret" : "Value"}</Label>
                                <div className="relative">
                                    <Input
                                        type={field.secret ? "password" : "text"}
                                        autoComplete="off"
                                        value={field.value}
                                        placeholder={field.secret && field.hasValue ? "•••• (keep current)" : ""}
                                        onChange={(event) =>
                                            setFields(fields.map((f, i) => (i === index ? { ...f, value: event.target.value } : f)))
                                        }
                                        className="pr-9"
                                    />
                                    <button
                                        type="button"
                                        onClick={() => setFields(fields.map((f, i) => (i === index ? { ...f, secret: !f.secret } : f)))}
                                        className="absolute inset-y-0 right-0 flex items-center px-2 text-ink-faint hover:text-ink transition-colors"
                                        aria-label={field.secret ? "Make plain text" : "Make secret"}
                                    >
                                        {field.secret ? <Lock size={13} /> : <Unlock size={13} />}
                                    </button>
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={() => setFields(fields.filter((_, i) => i !== index))}
                                className="flex h-[34px] w-[34px] items-center justify-center rounded-md text-ink-faint hover:text-danger hover:bg-danger-soft transition-colors"
                                aria-label={`Remove ${field.key || "field"}`}
                            >
                                <X size={13} />
                            </button>
                        </div>
                    ))}
                    <div className="flex items-center gap-2">
                        <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => setFields([...fields, { key: "", secret: false, value: "", hasValue: false }])}
                        >
                            <Plus size={13} /> Add field
                        </Button>
                        <div className="flex-1" />
                        <Button type="button" size="sm" variant="outline" onClick={() => setOpenId(null)}>Cancel</Button>
                        <Button type="submit" size="sm" disabled={saving}>{saving ? "Saving..." : "Save"}</Button>
                    </div>
                </form>
            )}
        </section>
    );
}
