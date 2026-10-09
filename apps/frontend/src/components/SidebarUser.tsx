"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ChevronsUpDown, Link2, LogOut, Monitor, Moon, Settings, SlidersHorizontal, Sun } from "lucide-react";
import { useAuth } from "@/components/AuthProvider";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api, errorMessage } from "@/lib/api";
import { setThemePreference, useThemePreference, type ThemePreference } from "@/lib/theme";

function initials(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

export function SidebarUser({ settingsHref, onSettings }: { settingsHref?: string; onSettings?: boolean }) {
    const { user, isAdmin, refresh } = useAuth();
    const router = useRouter();
    const theme = useThemePreference();
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
        setBusy(true); setError("");
        try { await api("/auth/logout", { method: "POST" }); await refresh(); router.replace("/login"); }
        catch (reason) { setError(errorMessage(reason)); setBusy(false); }
    }
    if (!user) return null;
    return (
        <div className="min-w-0">
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <button
                        type="button"
                        aria-label={`Account: ${user.name}`}
                        className="flex w-full min-w-0 items-center gap-2.5 rounded-md p-2 text-left outline-none transition-colors duration-200 hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-surface-hover"
                    >
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-meta font-semibold text-primary-foreground" aria-hidden="true">{initials(user.name)}</span>
                        <span className="min-w-0 flex-1 leading-tight">
                            <span className="block truncate text-control font-medium text-ink">{user.name}</span>
                            <span className="block truncate text-meta text-ink-muted">{user.email}</span>
                        </span>
                        <ChevronsUpDown size={14} className="shrink-0 text-ink-subtle" aria-hidden="true" />
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="start" sideOffset={6} className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-56">
                    <DropdownMenuLabel className="flex items-center gap-2.5 py-2">
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-meta font-semibold text-primary-foreground" aria-hidden="true">{initials(user.name)}</span>
                        <span className="min-w-0 leading-tight">
                            <span className="block truncate font-medium">{user.name}</span>
                            <span className="block truncate text-meta font-normal text-ink-muted">{user.email} · <span className="capitalize">{user.role}</span></span>
                        </span>
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {settingsHref && <DropdownMenuItem asChild className={onSettings ? "font-medium" : undefined}><Link href={settingsHref}><SlidersHorizontal size={14} /> Project settings</Link></DropdownMenuItem>}
                    {isAdmin && <DropdownMenuItem asChild><Link href="/settings"><Settings size={14} /> Instance settings</Link></DropdownMenuItem>}
                    <DropdownMenuSub>
                        <DropdownMenuSubTrigger>{theme === "dark" ? <Moon size={14} /> : theme === "light" ? <Sun size={14} /> : <Monitor size={14} />} Theme</DropdownMenuSubTrigger>
                        <DropdownMenuSubContent>
                            <DropdownMenuRadioGroup value={theme} onValueChange={(value) => setThemePreference(value as ThemePreference)}>
                                <DropdownMenuRadioItem value="light"><Sun size={14} /> Light</DropdownMenuRadioItem>
                                <DropdownMenuRadioItem value="dark"><Moon size={14} /> Dark</DropdownMenuRadioItem>
                                <DropdownMenuRadioItem value="system"><Monitor size={14} /> System</DropdownMenuRadioItem>
                            </DropdownMenuRadioGroup>
                        </DropdownMenuSubContent>
                    </DropdownMenuSub>
                    {ssoEnabled && <DropdownMenuItem disabled={busy} onSelect={() => void connectSso()}><Link2 size={14} /> Connect single sign-on</DropdownMenuItem>}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={(event) => { event.preventDefault(); void signOut(); }} disabled={busy}><LogOut size={14} /> {busy ? "Signing out…" : "Sign out"}</DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
            {error && <p role="alert" className="mt-1 px-2 text-meta text-danger">{error}</p>}
        </div>
    );
}
