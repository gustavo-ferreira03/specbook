"use client";

import Link from "next/link";
import { usePathname, useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { EmptyState } from "@/components/EmptyState";
import { Settings } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/PageHeader";
import { AppContext } from "@/components/AppContext";
import { CredentialProfilesCard } from "@/components/CredentialProfilesCard";
import { GitRemoteAccess } from "@/components/GitRemoteAccess";
import { RepositoryRecovery } from "@/components/RepositoryRecovery";
import { ProjectSettingsCard } from "@/components/ProjectSettingsCard";
import { AutomationSettingsCard } from "@/components/AutomationSettingsCard";
import { EnvironmentsSettingsCard } from "@/components/EnvironmentsSettingsCard";
import { AgentAccessSettingsCard } from "@/components/AgentAccessSettingsCard";
import { CiSettingsCard } from "@/components/CiSettingsCard";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const SETTINGS_TABS = ["general", "context", "automation", "git"] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number];
const TAB_LABELS: [SettingsTab, string][] = [["general", "General"], ["context", "App context"], ["automation", "Automation"], ["git", "Git"]];
const LEGACY_TABS: Record<string, SettingsTab> = { environments: "general", credentials: "general", ci: "automation" };

function SettingsContent() {
    const { canEdit, isAdmin } = useAuth();
    const { projectId } = useParams<{ projectId: string }>();
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const tab = searchParams.get("tab") ?? "";
    const activeTab = SETTINGS_TABS.includes(tab as SettingsTab) ? tab as SettingsTab : LEGACY_TABS[tab] ?? "general";
    const [gitToken, setGitToken] = useState<string | null>(null);
    const [agentToken, setAgentToken] = useState<{ projectId: string; token: string | null } | null>(null);
    const [ciToken, setCiToken] = useState<{ projectId: string; token: string | null } | null>(null);


    function selectTab(value: string) {
        const params = new URLSearchParams(searchParams.toString());
        if (value === "general") params.delete("tab");
        else params.set("tab", value);
        router.replace(params.size ? `${pathname}?${params}` : pathname, { scroll: false });
    }

    if (!canEdit) return <EmptyState title="Project settings are read-only" description="Your viewer account can read Specs, run results and evidence. Ask an editor to change project settings." />;
    return <div className="flex min-h-full flex-col bg-surface">
        <PageHeader title="Project settings" width="reading" bordered={false} className="pb-2 md:pb-3" />
        <Tabs value={activeTab} onValueChange={selectTab} className="flex-1">
            <div className="border-b border-line bg-surface px-4 md:px-8">
                <div className="mx-auto flex w-full max-w-reading items-center justify-between gap-4">
                    <TabsList aria-label="Project settings sections" className="min-w-0 border-b-0">
                        {TAB_LABELS.map(([value, label]) => <TabsTrigger key={value} value={value}>{label}</TabsTrigger>)}
                    </TabsList>
                    {isAdmin && <Link href="/settings" className="flex shrink-0 items-center gap-1.5 text-control text-ink-muted underline-offset-4 hover:text-ink hover:underline"><Settings size={13} /> Instance settings</Link>}
                </div>
            </div>
            <PageContainer width="reading" className="pb-16">
                <TabsContent value="general"><ProjectSettingsCard projectId={projectId}><EnvironmentsSettingsCard projectId={projectId} /><CredentialProfilesCard projectId={projectId} /></ProjectSettingsCard></TabsContent>
                <TabsContent value="context"><AppContext projectId={projectId} /></TabsContent>
                <TabsContent value="automation"><div className="space-y-10"><AutomationSettingsCard projectId={projectId} /><CiSettingsCard key={projectId} projectId={projectId} oneTimeToken={ciToken?.projectId === projectId ? ciToken.token : null} onOneTimeTokenChange={(token) => setCiToken({ projectId, token })} /><AgentAccessSettingsCard key={`agent-${projectId}`} projectId={projectId} oneTimeToken={agentToken?.projectId === projectId ? agentToken.token : null} onOneTimeTokenChange={(token) => setAgentToken({ projectId, token })} /></div></TabsContent>
                <TabsContent value="git"><div className="space-y-10"><RepositoryRecovery projectId={projectId} /><GitRemoteAccess projectId={projectId} oneTimeToken={gitToken} onOneTimeTokenChange={setGitToken} /></div></TabsContent>
            </PageContainer>
        </Tabs>
    </div>;
}

export default function SettingsPage() {
    return <Suspense fallback={<span className="sr-only" role="status">Loading settings</span>}><SettingsContent /></Suspense>;
}
