"use client";

import { useCallback, useEffect, useState } from "react";
import { Copy, UserPlus } from "lucide-react";
import { InlineFeedback, SettingsBlock, SettingsFooter, SettingsRow, SettingsSection } from "@/components/SettingsLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { api, apiPath, errorMessage } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { formatDateTime } from "@/lib/format";
import type { AuthUser } from "@/lib/types";

type Role = AuthUser["role"];
interface Members { members: (AuthUser & { disabledAt: string | null })[]; invitations: { id: string; email: string; role: Role; expiresAt: string }[] }

function RoleSelect({ value, onChange, disabled, label }: { value: Role; onChange: (value: Role) => void; disabled: boolean; label: string }) {
    return <Select value={value} onValueChange={(role) => onChange(role as Role)} disabled={disabled}><SelectTrigger aria-label={label} className="w-32"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="viewer">Viewer</SelectItem><SelectItem value="editor">Editor</SelectItem><SelectItem value="admin">Admin</SelectItem></SelectContent></Select>;
}

export function MembersSettings() {
    const [data, setData] = useState<Members | null>(null);
    const [email, setEmail] = useState("");
    const [role, setRole] = useState<Role>("viewer");
    const [inviteUrl, setInviteUrl] = useState("");
    const [busy, setBusy] = useState(false);
    const [feedback, setFeedback] = useState<{ type: "success" | "error"; text: string } | null>(null);
    const load = useCallback(async () => { try { setData(await api<Members>("/settings/members")); return true; } catch (reason) { setFeedback({ type: "error", text: errorMessage(reason) }); return false; } }, []);
    useEffect(() => { void load(); }, [load]);
    async function mutate(path: string, method: string, body?: unknown) {
        setBusy(true); setFeedback(null);
        try { await api(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) }); if (await load()) setFeedback({ type: "success", text: "Access updated." }); }
        catch (reason) { setFeedback({ type: "error", text: errorMessage(reason) }); }
        finally { setBusy(false); }
    }
    async function invite(event: React.FormEvent) {
        event.preventDefault(); setBusy(true); setFeedback(null); setInviteUrl("");
        try { const result = await api<{ inviteUrl: string }>("/settings/invitations", { method: "POST", body: JSON.stringify({ email: email.trim(), role }) }); setInviteUrl(result.inviteUrl); setEmail(""); await load(); }
        catch (reason) { setFeedback({ type: "error", text: errorMessage(reason) }); }
        finally { setBusy(false); }
    }
    return <div className="space-y-10">
        <SettingsSection id="invite-member-heading" title="Invite a member" description="Viewers can read. Editors can change projects and run checks. Admins also manage this instance.">
            <form onSubmit={invite}><SettingsRow label="Email" htmlFor="invite-email"><Input id="invite-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="colleague@example.com" required disabled={busy} /></SettingsRow><SettingsRow label="Role"><RoleSelect value={role} onChange={setRole} disabled={busy} label="Invitation role" /></SettingsRow><SettingsFooter feedback={<InlineFeedback feedback={feedback} />}><Button type="submit" disabled={busy}><UserPlus size={14} /> Create invitation</Button></SettingsFooter></form>
            {inviteUrl && <SettingsBlock><p className="mb-2 text-body text-ink">Send this link to the invited person. It is shown only once.</p><div className="flex gap-2"><Input aria-label="Invitation link" readOnly value={inviteUrl} onFocus={(event) => event.target.select()} /><Button variant="outline" onClick={() => void copyText(inviteUrl).then((copied) => setFeedback({ type: copied ? "success" : "error", text: copied ? "Invitation link copied." : "Select and copy the invitation link." }))}><Copy size={14} /> Copy</Button></div></SettingsBlock>}
        </SettingsSection>
        <SettingsSection id="members-heading" title="Members">
            {!data ? <SettingsBlock>{feedback?.type === "error" ? <Button variant="outline" onClick={() => void load()}>Try again</Button> : <Skeleton className="h-24 w-full" />}</SettingsBlock> : <ul>{data.members.map((member) => <li key={member.id} className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-4 last:border-0 sm:px-5"><div className="min-w-0 basis-full sm:basis-0 sm:flex-1"><p className="text-body font-medium text-ink">{member.name}</p><p className="break-all text-meta text-ink-muted">{member.email}</p></div>{member.disabledAt && <Badge variant="neutral">Disabled</Badge>}<RoleSelect value={member.role} onChange={(next) => void mutate(apiPath`/settings/members/${member.id}`, "PATCH", { role: next })} disabled={busy || Boolean(member.disabledAt)} label={`Role for ${member.name}`} /><Button variant={member.disabledAt ? "outline" : "ghost"} size="sm" disabled={busy} onClick={() => void mutate(apiPath`/settings/members/${member.id}`, "PATCH", { disabled: !member.disabledAt })}>{member.disabledAt ? "Restore access" : "Disable access"}</Button></li>)}</ul>}
        </SettingsSection>
        {Boolean(data?.invitations.length) && <SettingsSection id="pending-invitations-heading" title="Pending invitations"><ul>{data!.invitations.map((invitation) => <li key={invitation.id} className="flex items-start gap-3 border-b border-line px-4 py-4 last:border-0 sm:px-5"><div className="min-w-0 flex-1"><p className="break-all text-body text-ink">{invitation.email}</p><p className="mt-1 text-meta text-ink-muted">{invitation.role} · Expires {formatDateTime(invitation.expiresAt)}</p></div><Button variant="ghost" size="sm" disabled={busy} onClick={() => void mutate(apiPath`/settings/invitations/${invitation.id}`, "DELETE")}>Revoke</Button></li>)}</ul></SettingsSection>}
    </div>;
}
