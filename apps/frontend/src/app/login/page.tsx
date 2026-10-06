"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowRight, KeyRound } from "lucide-react";
import { useAuth } from "@/components/AuthProvider";
import { InstanceHeader } from "@/components/InstanceHeader";
import { PageContainer, PageHeader } from "@/components/PageHeader";
import { InlineFeedback, SettingsBlock, SettingsFooter, SettingsRow, SettingsSection } from "@/components/SettingsLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api, errorMessage, safeReturnPath } from "@/lib/api";

function LoginContent() {
    const router = useRouter();
    const search = useSearchParams();
    const { refresh } = useAuth();
    const [options, setOptions] = useState<{ passwordLoginEnabled: boolean; oidcEnabled: boolean } | null>(null);
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(search.get("error") ? "Single sign-on could not complete. Try again or contact your administrator." : "");
    useEffect(() => {
        let active = true;
        void api<{ needsAdmin: boolean; passwordLoginEnabled: boolean; oidcEnabled: boolean }>("/auth/options").then((result) => {
            if (!active) return;
            if (result.needsAdmin) { router.replace("/setup"); return; }
            setOptions(result);
        }).catch((reason) => { if (active) setError(errorMessage(reason)); });
        return () => { active = false; };
    }, [router]);
    async function login(event: React.FormEvent) {
        event.preventDefault(); setBusy(true); setError("");
        try {
            await api("/auth/login", { method: "POST", body: JSON.stringify({ email: email.trim(), password }) });
            setPassword(""); await refresh(); router.replace(safeReturnPath(search.get("next")));
        } catch (reason) { setError(errorMessage(reason)); setBusy(false); }
    }
    async function singleSignOn() {
        setBusy(true); setError("");
        try { const result = await api<{ url: string }>("/auth/oidc/start", { method: "POST", body: JSON.stringify({}) }); window.location.assign(result.url); }
        catch (reason) { setError(errorMessage(reason)); setBusy(false); }
    }
    return <main className="min-h-dvh bg-surface"><InstanceHeader setup />
        <PageHeader title="Sign in to Specbook" description="Use your account for this Specbook instance." width="reading" />
        <PageContainer width="reading"><SettingsSection id="sign-in-heading" title="Your account">
            {!options && !error ? <SettingsBlock><Skeleton className="h-32 w-full" /></SettingsBlock> : <>
                {options?.oidcEnabled && <SettingsBlock><Button variant="outline" onClick={() => void singleSignOn()} disabled={busy}><KeyRound size={14} /> Continue with single sign-on</Button></SettingsBlock>}
                {options?.passwordLoginEnabled && <form onSubmit={login}>
                    <SettingsRow label="Email" htmlFor="login-email"><Input id="login-email" type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} disabled={busy} /></SettingsRow>
                    <SettingsRow label="Password" htmlFor="login-password"><Input id="login-password" type="password" autoComplete="current-password" required maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} /></SettingsRow>
                    <SettingsFooter feedback={<InlineFeedback feedback={error ? { type: "error", text: error } : null} />}><Button type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}<ArrowRight size={14} /></Button></SettingsFooter>
                </form>}
                {!options?.passwordLoginEnabled && error && <SettingsBlock><InlineFeedback feedback={{ type: "error", text: error }} /></SettingsBlock>}
                {!options && error && <SettingsBlock><Button variant="outline" onClick={() => window.location.reload()}>Try again</Button></SettingsBlock>}
            </>}
        </SettingsSection><p className="mt-4 text-body text-ink-muted">Need an account? Ask your administrator for an invitation link.</p></PageContainer>
    </main>;
}

export default function LoginPage() { return <Suspense fallback={<span className="sr-only" role="status">Loading sign in</span>}><LoginContent /></Suspense>; }
