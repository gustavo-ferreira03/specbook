"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ChevronDown, Link2, LogOut, Settings, UserRound } from "lucide-react";
import { useAuth } from "@/components/AuthProvider";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { api, errorMessage } from "@/lib/api";

export function UserMenu() {
    const { user, isAdmin, refresh } = useAuth();
    const router = useRouter();
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const [ssoEnabled, setSsoEnabled] = useState(false);
    useEffect(() => { api<{ oidcEnabled: boolean }>("/auth/options").then((result) => setSsoEnabled(result.oidcEnabled)).catch(() => undefined); }, []);
    async function connectSso() {
        setBusy(true); setError("");
        try { const result = await api<{ url: string }>("/auth/oidc/start", { method: "POST", body: JSON.stringify({ link: true }) }); window.location.assign(result.url); }
        catch (reason) { setError(errorMessage(reason)); setBusy(false); }
    }
    async function signOut() {
        setBusy(true);
        setError("");
        try { await api("/auth/logout", { method: "POST" }); await refresh(); router.replace("/login"); }
        catch (reason) { setError(errorMessage(reason)); setBusy(false); }
    }
    if (!user) return null;
    return <div className="min-w-0">
        <DropdownMenu>
            <DropdownMenuTrigger asChild><Button variant="ghost" size="sm" className="max-w-full" aria-label={`Account: ${user.name}`}><UserRound size={14} /><span className="max-w-32 truncate">{user.name}</span><ChevronDown size={12} /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-w-[calc(100vw-32px)]">
                <DropdownMenuLabel><p className="truncate font-medium">{user.name}</p><p className="mt-0.5 truncate text-meta font-normal text-ink-muted">{user.email}</p><p className="mt-0.5 text-meta font-normal capitalize text-ink-muted">{user.role}</p></DropdownMenuLabel>
                {isAdmin && <><DropdownMenuSeparator /><DropdownMenuItem asChild><Link href="/settings"><Settings size={14} /> Instance settings</Link></DropdownMenuItem></>}
                {ssoEnabled && <DropdownMenuItem disabled={busy} onSelect={() => void connectSso()}><Link2 size={14} /> Connect single sign-on</DropdownMenuItem>}
                <DropdownMenuSeparator /><DropdownMenuItem onSelect={(event) => { event.preventDefault(); void signOut(); }} disabled={busy}><LogOut size={14} /> {busy ? "Signing out..." : "Sign out"}</DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
        {error && <p role="alert" className="mt-1 text-meta text-danger">{error}</p>}
    </div>;
}
