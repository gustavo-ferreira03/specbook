"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CircleCheck, HardDrive, Network, Plus, Server, Trash2, Unplug } from "lucide-react";
import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { useAuth } from "@/components/AuthProvider";
import { InlineFeedback, SettingsFooter, SettingsRow, SettingsSection, type InlineFeedbackValue } from "@/components/SettingsLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, apiPath, errorMessage, getEnvironments, listCredentialProfiles } from "@/lib/api";
import type { CredentialProfile, ProjectEnvironment } from "@/lib/types";
import { useProjectTunnels } from "@/lib/useProjectTunnels";
import { invalidate } from "@/lib/invalidation";

const blank: Omit<ProjectEnvironment, "id" | "projectId"> = { name: "", baseUrl: "", allowedOrigins: [], credentialOverrides: {}, executor: "server", runnerGroup: null };

export function EnvironmentsSettingsCard({ projectId }: { projectId: string }) {
    const { isAdmin } = useAuth();
    const { tunnels, error: tunnelError } = useProjectTunnels(projectId);
    const [environments, setEnvironments] = useState<ProjectEnvironment[]>([]);
    const [profiles, setProfiles] = useState<CredentialProfile[]>([]);
    const [editing, setEditing] = useState<string | null>(null);
    const [draft, setDraft] = useState<Omit<ProjectEnvironment, "id" | "projectId">>(blank);
    const [origins, setOrigins] = useState("");
    const [busy, setBusy] = useState(false);
    const [feedback, setFeedback] = useState<InlineFeedbackValue | null>(null);
    const [deleting, setDeleting] = useState<ProjectEnvironment | null>(null);
    const returnFocusRef = useRef<HTMLElement | null>(null);
    const destinationRestricted = !isAdmin && draft.executor !== "server";
    const load = useCallback(async () => {
        try {
            const [saved, credentials] = await Promise.all([getEnvironments(projectId), listCredentialProfiles(projectId)]);
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
            await api(path, { method: editing === "new" ? "POST" : "PUT", body: JSON.stringify({ name: draft.name.trim(), baseUrl: draft.baseUrl.trim(), allowedOrigins: origins.split(/\r?\n/).map((value) => value.trim()).filter(Boolean), credentialOverrides: draft.executor === "runner" ? {} : draft.credentialOverrides, executor: draft.executor, runnerGroup: draft.executor !== "server" ? draft.runnerGroup?.trim() || null : null }) });
            invalidate({ resource: "projects", projectId });
            setEditing(null);
            await load();
            setFeedback({ type: "success", text: "Environment saved." });
        } catch (error) { setFeedback({ type: "error", text: errorMessage(error) }); }
        finally { setBusy(false); }
    }

    return <SettingsSection id="environments-heading" title="Environments" description="Choose a destination when running Specs. Schedules use Production; CI can choose any saved environment.">
        {environments.map((environment) => <div key={environment.id} className="flex items-center justify-between gap-3 border-b border-line px-4 py-4 sm:px-5">
            <div className="min-w-0"><p className="text-body font-medium text-ink">{environment.name}</p><p className="mt-1 break-all text-meta text-ink-muted">{environment.baseUrl}</p><p className="mt-1 flex items-center gap-1.5 text-meta text-ink-muted">{environment.executor === "runner" ? <HardDrive size={13} aria-hidden="true" /> : environment.executor === "tunnel" ? <Network size={13} aria-hidden="true" /> : <Server size={13} aria-hidden="true" />}{environment.executor === "server" ? "Specbook server" : `${environment.executor === "tunnel" ? "Server through a tunnel" : "Runner"}${environment.runnerGroup ? ` · ${environment.runnerGroup}` : " · Ungrouped"}`}</p>{environment.executor === "tunnel" && <div className="mt-2 space-y-1">{tunnelError ? <p role="alert" className="text-meta text-danger">Tunnel status is unavailable: {tunnelError}</p> : tunnels === null ? <p className="text-meta text-ink-muted">Checking tunnel connection…</p> : <p className={`flex items-center gap-1.5 text-meta ${tunnels.find((tunnel) => tunnel.environmentId === environment.id)?.connected ? "text-success" : "text-ink-muted"}`}>{tunnels.find((tunnel) => tunnel.environmentId === environment.id)?.connected ? <CircleCheck size={13} aria-hidden="true" /> : <Unplug size={13} aria-hidden="true" />}{tunnels.find((tunnel) => tunnel.environmentId === environment.id)?.connected ? "Tunnel connected" : "No tunnel connected"}</p>}<code className="block break-all font-mono text-meta text-ink-muted">{tunnels?.find((tunnel) => tunnel.environmentId === environment.id)?.command ?? `specbook tunnel --project ${projectId} --environment ${environment.id}`}</code></div>}</div>
            <div className="flex shrink-0 gap-1"><Button variant="ghost" size="sm" disabled={busy} onClick={() => edit(environment)}>Edit</Button>{environment.name !== "Production" && <Button variant="ghost" size="icon-sm" aria-label={`Delete ${environment.name}`} onClick={(event) => { returnFocusRef.current = event.currentTarget; setDeleting(environment); }}><Trash2 size={14} /></Button>}</div>
        </div>)}
        {editing !== null ? <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
            <SettingsRow label="Name" htmlFor="environment-name"><Input id="environment-name" value={draft.name} disabled={busy || draft.name === "Production" && editing !== "new"} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Staging" /></SettingsRow>
            <SettingsRow label="Base URL" htmlFor="environment-url" description={destinationRestricted ? "Only an administrator can change destinations for runners and tunnels." : undefined}><Input id="environment-url" type="url" required value={draft.baseUrl} disabled={busy || destinationRestricted} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} placeholder="https://staging.example.com" /></SettingsRow>
            <SettingsRow label="Executor" htmlFor="environment-executor" description={isAdmin ? "Manual runs, CI, schedules and deploy signals use this executor." : "Only an administrator can change the executor."}><Select value={draft.executor} onValueChange={(value: ProjectEnvironment["executor"]) => setDraft({ ...draft, executor: value, runnerGroup: value !== "server" ? draft.runnerGroup : null, credentialOverrides: value === "runner" ? {} : draft.credentialOverrides })} disabled={busy || !isAdmin}><SelectTrigger id="environment-executor"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="server">Specbook server</SelectItem><SelectItem value="runner">Runner in a private network</SelectItem><SelectItem value="tunnel">Server through a tunnel</SelectItem></SelectContent></Select></SettingsRow>
            {draft.executor !== "server" && <SettingsRow label="Runner group" htmlFor="environment-runner-group" description={draft.executor === "tunnel" ? "Required. Connect with a runner token restricted to this group and allowed to access this project." : "Optional. Only runners with this group can claim these runs. Leave empty for ungrouped runners."}><Input id="environment-runner-group" value={draft.runnerGroup ?? ""} disabled={busy || !isAdmin} required={draft.executor === "tunnel"} maxLength={80} onChange={(event) => setDraft({ ...draft, runnerGroup: event.target.value })} placeholder="private-staging" /></SettingsRow>}
            {draft.executor === "runner" && <>
                <SettingsRow label="Local credentials" description="Credentials stay on the runner. Specs resolve secret(profile, field) from profiles saved with specbook credentials under its SPECBOOK_HOME."><p className="text-control text-ink-muted">Server credential profiles and overrides are not used. Agent browser exploration is unavailable for runner environments.</p></SettingsRow>
            </>}
            {draft.executor === "tunnel" && <SettingsRow label="Tunnel connection" description="The server runs browsers and keeps credentials in its vault. An outbound tunnel carries traffic only to this environment's allowed origins."><p className="text-control text-ink-muted">Agent browser exploration is available when the tunnel connects. Inside the private network, configure <code className="font-mono text-meta">SPECBOOK_URL</code> and <code className="font-mono text-meta">SPECBOOK_RUNNER_TOKEN</code>, then start <code className="font-mono text-meta">specbook tunnel</code> for this project and environment.</p></SettingsRow>}
            <SettingsRow label="Allowed origins" htmlFor="environment-origins" description="Optional. Exact origins for API calls or preview URLs, one per line. The base URL is always allowed."><Textarea id="environment-origins" value={origins} rows={3} disabled={busy || destinationRestricted} onChange={(event) => setOrigins(event.target.value)} placeholder="https://api.staging.example.com" className="font-mono text-meta" /></SettingsRow>
            {draft.executor !== "runner" && profiles.length > 0 && <SettingsRow label="Credential overrides" description="Optional. Use another saved profile for a Spec's credentials in this environment. This explicitly authorizes the selected profile at this base URL."><div className="space-y-3">{profiles.map((profile) => <div key={profile.id} className="grid items-center gap-2 sm:grid-cols-2"><label htmlFor={`override-${profile.id}`} className="text-control text-ink-muted">{profile.name}</label><Select value={draft.credentialOverrides[profile.name] ?? "default"} onValueChange={(value) => { const next = { ...draft.credentialOverrides }; if (value === "default") delete next[profile.name]; else next[profile.name] = value; setDraft({ ...draft, credentialOverrides: next }); }} disabled={busy}><SelectTrigger id={`override-${profile.id}`}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="default">Use original profile</SelectItem>{profiles.map((target) => <SelectItem key={target.id} value={target.id}>{target.name}</SelectItem>)}</SelectContent></Select></div>)}</div></SettingsRow>}
            <SettingsFooter feedback={feedback && <InlineFeedback feedback={feedback} />}><Button type="button" variant="ghost" disabled={busy} onClick={() => { setEditing(null); setFeedback(null); }}>Cancel</Button><Button disabled={busy || !draft.name.trim() || !draft.baseUrl.trim() || draft.executor === "tunnel" && !draft.runnerGroup?.trim()}>{busy ? "Saving…" : "Save environment"}</Button></SettingsFooter>
        </form> : <SettingsFooter feedback={feedback && <InlineFeedback feedback={feedback} />}><Button variant="outline" onClick={() => edit()}><Plus size={14} /> Add environment</Button></SettingsFooter>}
        <ConfirmDeleteDialog open={deleting !== null} title={`Delete ${deleting?.name ?? "environment"}?`} description="Existing run results keep their original environment details." confirmLabel="Delete environment" busyLabel="Deleting…" busy={busy} error={feedback?.type === "error" ? feedback.text : ""} returnFocusRef={returnFocusRef} onCancel={() => setDeleting(null)} onConfirm={async () => { if (!deleting) return; setBusy(true); try { await api(apiPath`/projects/${projectId}/environments/${deleting.id}`, { method: "DELETE" }); invalidate({ resource: "projects", projectId }); setDeleting(null); await load(); } catch (error) { setFeedback({ type: "error", text: errorMessage(error) }); } finally { setBusy(false); } }} />
    </SettingsSection>;
}
