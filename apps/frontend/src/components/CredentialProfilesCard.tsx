"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, KeyRound, Plus, Trash2 } from "lucide-react";
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
            setError(err instanceof Error ? err.message : String(err));
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
        <section className="mt-7 space-y-3" aria-labelledby="credentials-heading">
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
            <ul className="divide-y divide-line border-y border-line empty:border-none">
                {profiles.map((profile) => (
                    <li key={profile.id} className="flex items-center justify-between gap-3 py-2">
                        <button type="button" className="min-w-0 flex-1 text-left" onClick={() => openEdit(profile)}>
                            <p className="text-[0.71875rem] font-bold">{profile.name}</p>
                            <p className="truncate text-[0.625rem] text-ink-faint">
                                {profile.fields.map((field) => (field.secret ? `${field.key}: ••••` : `${field.key}: ${field.value}`)).join("  ·  ")}
                            </p>
                        </button>
                        <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            aria-label={`Delete ${profile.name}`}
                            onClick={() => void remove(profile.id)}
                        >
                            <Trash2 size={13} />
                        </Button>
                    </li>
                ))}
            </ul>
            {openId && (
                <form
                    className="space-y-3 rounded-lg border border-line bg-surface-soft p-3"
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
                            <div className="w-36">
                                <Label>Field</Label>
                                <Input
                                    value={field.key}
                                    onChange={(event) =>
                                        setFields(fields.map((f, i) => (i === index ? { ...f, key: event.target.value } : f)))
                                    }
                                />
                            </div>
                            <div className="flex-1">
                                <Label>{field.secret ? "Secret value" : "Value"}</Label>
                                <Input
                                    type={field.secret ? "password" : "text"}
                                    autoComplete="off"
                                    value={field.value}
                                    placeholder={field.secret && field.hasValue ? "•••• (keep current)" : ""}
                                    onChange={(event) =>
                                        setFields(fields.map((f, i) => (i === index ? { ...f, value: event.target.value } : f)))
                                    }
                                />
                            </div>
                            <label className="flex items-center gap-1 pb-2 text-[0.625rem] text-ink-faint">
                                <input
                                    type="checkbox"
                                    checked={field.secret}
                                    onChange={(event) =>
                                        setFields(fields.map((f, i) => (i === index ? { ...f, secret: event.target.checked } : f)))
                                    }
                                />
                                secret
                            </label>
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
