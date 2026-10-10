"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowRight, KeyRound } from "lucide-react";
import { useAuth } from "@/components/AuthProvider";
import { AuthField, AuthShell } from "@/components/AuthShell";
import { InlineFeedback } from "@/components/SettingsLayout";
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
    return <AuthShell title="Sign in" footer="Need an account? Ask your administrator for an invitation link.">
        {!options && !error ? <Skeleton className="h-44 w-full" /> : <div className="space-y-5">
            {options?.oidcEnabled && <Button variant="outline" className="h-10 w-full" onClick={() => void singleSignOn()} disabled={busy}><KeyRound size={14} /> Continue with single sign-on</Button>}
            {options?.oidcEnabled && options.passwordLoginEnabled && <div className="flex items-center gap-3 text-meta text-ink-subtle"><span className="h-px flex-1 bg-line" />or<span className="h-px flex-1 bg-line" /></div>}
            {options?.passwordLoginEnabled && <form onSubmit={login} className="space-y-4">
                <AuthField id="login-email" label="Email"><Input id="login-email" type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} disabled={busy} className="h-10" /></AuthField>
                <AuthField id="login-password" label="Password"><Input id="login-password" type="password" autoComplete="current-password" required maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} className="h-10" /></AuthField>
                <InlineFeedback feedback={error ? { type: "error", text: error } : null} />
                <Button type="submit" className="h-10 w-full" disabled={busy}>{busy ? "Signing in…" : "Sign in"}<ArrowRight size={14} /></Button>
            </form>}
            {!options?.passwordLoginEnabled && error && <InlineFeedback feedback={{ type: "error", text: error }} />}
            {!options && error && <Button variant="outline" className="h-10 w-full" onClick={() => window.location.reload()}>Try again</Button>}
        </div>}
    </AuthShell>;
}

export default function LoginPage() { return <Suspense fallback={<span className="sr-only" role="status">Loading sign in</span>}><LoginContent /></Suspense>; }
