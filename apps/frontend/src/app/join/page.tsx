"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/AuthProvider";
import { InstanceHeader } from "@/components/InstanceHeader";
import { PageContainer, PageHeader } from "@/components/PageHeader";
import { InlineFeedback, SettingsBlock, SettingsFooter, SettingsRow, SettingsSection } from "@/components/SettingsLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

export default function JoinPage() {
    const router = useRouter();
    const { refresh } = useAuth();
    const token = useRef<string | null>(null);
    const [invitation, setInvitation] = useState<{ email: string; role: string; expiresAt: string } | null>(null);
    const [name, setName] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        if (token.current === null) { token.current = new URLSearchParams(window.location.hash.slice(1)).get("token") ?? ""; window.history.replaceState(window.history.state, "", "/join"); }
        if (!token.current) { setError("This invitation link is incomplete. Ask your administrator for a new link."); return; }
        let active = true;
        void api<{ email: string; role: string; expiresAt: string }>("/auth/invitations/inspect", { method: "POST", body: JSON.stringify({ token: token.current }) }).then((result) => { if (active) setInvitation(result); }).catch((reason) => { if (active) setError(errorMessage(reason)); });
        return () => { active = false; };
    }, []);
    async function accept(event: React.FormEvent) {
        event.preventDefault(); setBusy(true); setError("");
        try { await api("/auth/invitations/accept", { method: "POST", body: JSON.stringify({ token: token.current, name: name.trim(), password }) }); setPassword(""); token.current = ""; await refresh(); router.replace("/"); }
        catch (reason) { setError(errorMessage(reason)); setBusy(false); }
    }
    return <main className="min-h-dvh bg-surface"><InstanceHeader setup /><PageHeader title="Join Specbook" description="Create your account to accept the invitation." width="reading" />
        <PageContainer width="reading"><SettingsSection id="invitation-heading" title="Your invitation">
            {!invitation ? <SettingsBlock>{error ? <InlineFeedback feedback={{ type: "error", text: error }} /> : <Skeleton className="h-32 w-full" />}</SettingsBlock> : <form onSubmit={accept}>
                <SettingsBlock><p className="text-body text-ink">Invited as <strong className="font-medium">{invitation.email}</strong> with <span className="font-medium">{invitation.role}</span> access.</p><p className="mt-1 text-meta text-ink-subtle">Expires {formatDateTime(invitation.expiresAt)}</p></SettingsBlock>
                <SettingsRow label="Name" htmlFor="join-name"><Input id="join-name" value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" required disabled={busy} /></SettingsRow>
                <SettingsRow label="Password" htmlFor="join-password" description="Use at least 12 characters."><Input id="join-password" value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="new-password" minLength={12} maxLength={128} required disabled={busy} /></SettingsRow>
                <SettingsFooter feedback={<InlineFeedback feedback={error ? { type: "error", text: error } : null} />}><Button type="submit" disabled={busy}>{busy ? "Creating account…" : "Accept invitation"}</Button></SettingsFooter>
            </form>}
        </SettingsSection><Button asChild variant="link" className="mt-4 px-0"><Link href="/login">Already have an account? Sign in</Link></Button></PageContainer>
    </main>;
}
