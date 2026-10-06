"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { InlineFeedback, SettingsFooter, SettingsRow, SettingsSection } from "@/components/SettingsLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, apiPath, errorMessage, getEnvironments } from "@/lib/api";
import type { CredentialProfile, ProjectEnvironment } from "@/lib/types";

const blank = { name: "", baseUrl: "", allowedOrigins: [], credentialOverrides: {} };

export function EnvironmentsSettingsCard({ projectId }: { projectId: string }) {
    const [environments, setEnvironments] = useState<ProjectEnvironment[]>([]);
    const [profiles, setProfiles] = useState<CredentialProfile[]>([]);
    const [editing, setEditing] = useState<string | null>(null);
    const [draft, setDraft] = useState<Omit<ProjectEnvironment, "id" | "projectId">>(blank);
    const [origins, setOrigins] = useState("");
    const [busy, setBusy] = useState(false);
    const [feedback, setFeedback] = useState<{ type: "success" | "error"; text: string } | null>(null);
    const [deleting, setDeleting] = useState<ProjectEnvironment | null>(null);
    const returnFocusRef = useRef<HTMLElement | null>(null);
    const load = useCallback(async () => {
        try {
            const [saved, credentials] = await Promise.all([getEnvironments(projectId), api<{ profiles: CredentialProfile[] }>(apiPath`/projects/${projectId}/credentials`)]);
            setEnvironments(saved.environments);
            setProfiles(credentials.profiles);
        } catch (error) { setFeedback({ type: "error", text: errorMessage(error) }); }
    }, [projectId]);
    useEffect(() => { void load(); }, [load]);

    function edit(environment?: ProjectEnvironment) {
        setEditing(environment?.id ?? "new");
        setDraft(environment ?? blank);
        setOrigins(environment?.allowedOrigins.join("\n") ?? "");
        setFeedback(null);
    }
    async function save() {
        setBusy(true);
        try {
            const path = editing === "new" ? apiPath`/projects/${projectId}/environments` : apiPath`/projects/${projectId}/environments/${editing!}`;
            await api(path, { method: editing === "new" ? "POST" : "PUT", body: JSON.stringify({ name: draft.name.trim(), baseUrl: draft.baseUrl.trim(), allowedOrigins: origins.split(/\r?\n/).map((value) => value.trim()).filter(Boolean), credentialOverrides: draft.credentialOverrides }) });
            setEditing(null);
            await load();
            setFeedback({ type: "success", text: "Environment saved." });
        } catch (error) { setFeedback({ type: "error", text: errorMessage(error) }); }
        finally { setBusy(false); }
    }

    return <SettingsSection id="environments-heading" title="Environments" description="Choose a destination when running Specs. Schedules use Production; CI can choose any saved environment.">
        {environments.map((environment) => <div key={environment.id} className="flex items-center justify-between gap-3 border-b border-line px-4 py-4 sm:px-5">
            <div className="min-w-0"><p className="text-body font-medium text-ink">{environment.name}</p><p className="mt-1 break-all text-meta text-ink-muted">{environment.baseUrl}</p></div>
            <div className="flex shrink-0 gap-1"><Button variant="ghost" size="sm" disabled={busy} onClick={() => edit(environment)}>Edit</Button>{environment.name !== "Production" && <Button variant="ghost" size="icon-sm" aria-label={`Delete ${environment.name}`} onClick={(event) => { returnFocusRef.current = event.currentTarget; setDeleting(environment); }}><Trash2 size={14} /></Button>}</div>
        </div>)}
        {editing !== null ? <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
            <SettingsRow label="Name" htmlFor="environment-name"><Input id="environment-name" value={draft.name} disabled={busy || draft.name === "Production" && editing !== "new"} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Staging" /></SettingsRow>
            <SettingsRow label="Base URL" htmlFor="environment-url"><Input id="environment-url" type="url" required value={draft.baseUrl} disabled={busy} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} placeholder="https://staging.example.com" /></SettingsRow>
            <SettingsRow label="Allowed origins" htmlFor="environment-origins" description="Optional. Exact origins for API calls or preview URLs, one per line. The base URL is always allowed."><Textarea id="environment-origins" value={origins} rows={3} disabled={busy} onChange={(event) => setOrigins(event.target.value)} placeholder="https://api.staging.example.com" className="font-mono text-meta" /></SettingsRow>
            {profiles.length > 0 && <SettingsRow label="Credential overrides" description="Optional. Use another saved profile for a Spec's credentials in this environment. This explicitly authorizes the selected profile at this base URL."><div className="space-y-3">{profiles.map((profile) => <div key={profile.id} className="grid items-center gap-2 sm:grid-cols-2"><label htmlFor={`override-${profile.id}`} className="text-control text-ink-muted">{profile.name}</label><Select value={draft.credentialOverrides[profile.name] ?? "default"} onValueChange={(value) => { const next = { ...draft.credentialOverrides }; if (value === "default") delete next[profile.name]; else next[profile.name] = value; setDraft({ ...draft, credentialOverrides: next }); }} disabled={busy}><SelectTrigger id={`override-${profile.id}`}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="default">Use original profile</SelectItem>{profiles.map((target) => <SelectItem key={target.id} value={target.id}>{target.name}</SelectItem>)}</SelectContent></Select></div>)}</div></SettingsRow>}
            <SettingsFooter feedback={feedback && <InlineFeedback feedback={feedback} />}><Button type="button" variant="ghost" disabled={busy} onClick={() => { setEditing(null); setFeedback(null); }}>Cancel</Button><Button disabled={busy || !draft.name.trim() || !draft.baseUrl.trim()}>{busy ? "Saving…" : "Save environment"}</Button></SettingsFooter>
        </form> : <SettingsFooter feedback={feedback && <InlineFeedback feedback={feedback} />}><Button variant="outline" onClick={() => edit()}><Plus size={14} /> Add environment</Button></SettingsFooter>}
        <ConfirmDeleteDialog open={deleting !== null} title={`Delete ${deleting?.name ?? "environment"}?`} description="Existing run results keep their original environment details." confirmLabel="Delete environment" busyLabel="Deleting…" busy={busy} error={feedback?.type === "error" ? feedback.text : ""} returnFocusRef={returnFocusRef} onCancel={() => setDeleting(null)} onConfirm={async () => { if (!deleting) return; setBusy(true); try { await api(apiPath`/projects/${projectId}/environments/${deleting.id}`, { method: "DELETE" }); setDeleting(null); await load(); } catch (error) { setFeedback({ type: "error", text: errorMessage(error) }); } finally { setBusy(false); } }} />
    </SettingsSection>;
}
