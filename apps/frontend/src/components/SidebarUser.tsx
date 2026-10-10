"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { EllipsisVertical, Link2, LogOut, Monitor, Moon, Settings, Sun, SunMoon } from "lucide-react";
import { useAuth } from "@/components/AuthProvider";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api, errorMessage } from "@/lib/api";
import { setThemePreference, useThemePreference, type ThemePreference } from "@/lib/theme";

function initials(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

const THEMES = [
    { value: "light", label: "Light", Icon: Sun },
    { value: "dark", label: "Dark", Icon: Moon },
    { value: "system", label: "System", Icon: Monitor },
] as const;

function Avatar({ name }: { name: string }) {
    return <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-meta font-semibold text-primary-foreground" aria-hidden="true">{initials(name)}</span>;
}

function ThemeSwitch() {
    const theme = useThemePreference();
    return (
        <div className="flex min-h-9 items-center justify-between gap-2 pr-1 pl-2.5 text-control text-ink">
            <span className="flex items-center gap-2"><SunMoon size={14} className="text-ink-subtle" aria-hidden="true" /> Theme</span>
            <DropdownMenuRadioGroup value={theme} onValueChange={(value) => setThemePreference(value as ThemePreference)} aria-label="Theme" className="flex items-center gap-0.5 rounded-md border border-line p-0.5">
                {THEMES.map(({ value, label, Icon }) => (
                    <DropdownMenuRadioItem
                        key={value}
                        value={value}
                        indicator={false}
                        aria-label={label}
                        title={label}
                        onSelect={(event) => event.preventDefault()}
                        className="size-6 min-h-6 justify-center rounded-[5px] text-ink-muted data-[highlighted]:text-ink data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=checked]:data-[highlighted]:bg-primary data-[state=checked]:data-[highlighted]:text-primary-foreground"
                    >
                        <Icon size={13} className="text-current" aria-hidden="true" />
                    </DropdownMenuRadioItem>
                ))}
            </DropdownMenuRadioGroup>
        </div>
    );
}

export function SidebarUser() {
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
                        <Avatar name={user.name} />
                        <span className="min-w-0 flex-1 leading-tight">
                            <span className="block truncate text-control font-medium text-ink">{user.name}</span>
                            <span className="block truncate text-meta text-ink-muted">{user.email}</span>
                        </span>
                        <EllipsisVertical size={15} className="shrink-0 text-ink-subtle" aria-hidden="true" />
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="start" sideOffset={6} className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-56">
                    <DropdownMenuLabel className="flex items-center gap-2.5 py-2">
                        <Avatar name={user.name} />
                        <span className="min-w-0 leading-tight">
                            <span className="block truncate font-medium text-ink">{user.name}</span>
                            <span className="block truncate text-meta font-normal text-ink-muted">{user.email} · <span className="capitalize">{user.role}</span></span>
                        </span>
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {isAdmin && <DropdownMenuItem asChild><Link href="/settings"><Settings size={14} /> Instance settings</Link></DropdownMenuItem>}
                    <ThemeSwitch />
                    {ssoEnabled && <DropdownMenuItem disabled={busy} onSelect={() => void connectSso()}><Link2 size={14} /> Connect single sign-on</DropdownMenuItem>}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={(event) => { event.preventDefault(); void signOut(); }} disabled={busy}><LogOut size={14} /> {busy ? "Signing out…" : "Sign out"}</DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
            {error && <p role="alert" className="mt-1 px-2 text-meta text-danger">{error}</p>}
        </div>
    );
}
