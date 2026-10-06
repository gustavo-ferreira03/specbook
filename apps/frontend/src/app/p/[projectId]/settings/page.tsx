"use client";

import Link from "next/link";
import { usePathname, useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { EmptyState } from "@/components/EmptyState";
import { Settings } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/PageHeader";
import { CredentialProfilesCard } from "@/components/CredentialProfilesCard";
import { GitRemoteAccess } from "@/components/GitRemoteAccess";
import { RepositoryRecovery } from "@/components/RepositoryRecovery";
import { ProjectSettingsCard } from "@/components/ProjectSettingsCard";
import { AutomationSettingsCard } from "@/components/AutomationSettingsCard";
import { EnvironmentsSettingsCard } from "@/components/EnvironmentsSettingsCard";
import { CiSettingsCard } from "@/components/CiSettingsCard";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const SETTINGS_TABS = ["general", "environments", "git", "credentials", "automation", "ci"] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number];
const TAB_LABELS: [SettingsTab, string][] = [["general", "General"], ["environments", "Environments"], ["git", "Git"], ["credentials", "Credentials"], ["automation", "Automation"], ["ci", "CI/CD"]];

function SettingsContent() {
    const { canEdit, isAdmin } = useAuth();
    const { projectId } = useParams<{ projectId: string }>();
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const tab = searchParams.get("tab");
    const activeTab = SETTINGS_TABS.includes(tab as SettingsTab) ? tab as SettingsTab : "general";
    const [gitToken, setGitToken] = useState<string | null>(null);
    const [ciToken, setCiToken] = useState<{ projectId: string; token: string | null } | null>(null);


    function selectTab(value: string) {
        const params = new URLSearchParams(searchParams.toString());
        if (value === "general") params.delete("tab");
        else params.set("tab", value);
        router.replace(params.size ? `${pathname}?${params}` : pathname, { scroll: false });
    }

    if (!canEdit) return <EmptyState title="Project settings are read-only" description="Your viewer account can read Specs, run results and evidence. Ask an editor to change project settings." />;
    return <div className="flex min-h-full flex-col bg-surface">
        <PageHeader title="Project settings" width="reading" bordered={false} className="pb-2 md:pb-3"
            actions={isAdmin && <Button asChild variant="ghost"><Link href="/settings"><Settings size={14} /> Instance settings</Link></Button>} />
        <Tabs value={activeTab} onValueChange={selectTab} className="flex-1">
            <div className="border-b border-line bg-surface px-4 md:px-8">
                <TabsList aria-label="Project settings sections" className="mx-auto w-full max-w-reading border-b-0">
                    {TAB_LABELS.map(([value, label]) => <TabsTrigger key={value} value={value}>{label}</TabsTrigger>)}
                </TabsList>
            </div>
            <PageContainer width="reading" className="pb-16">
                <TabsContent value="general"><ProjectSettingsCard projectId={projectId} /></TabsContent>
                <TabsContent value="environments"><EnvironmentsSettingsCard projectId={projectId} /></TabsContent>
                <TabsContent value="git"><div className="space-y-10"><RepositoryRecovery projectId={projectId} /><GitRemoteAccess projectId={projectId} oneTimeToken={gitToken} onOneTimeTokenChange={setGitToken} /></div></TabsContent>
                <TabsContent value="credentials"><CredentialProfilesCard projectId={projectId} /></TabsContent>
                <TabsContent value="automation"><AutomationSettingsCard projectId={projectId} /></TabsContent>
                <TabsContent value="ci"><CiSettingsCard key={projectId} projectId={projectId} oneTimeToken={ciToken?.projectId === projectId ? ciToken.token : null} onOneTimeTokenChange={(token) => setCiToken({ projectId, token })} /></TabsContent>
            </PageContainer>
        </Tabs>
    </div>;
}

export default function SettingsPage() {
    return <Suspense fallback={<span className="sr-only" role="status">Loading settings</span>}><SettingsContent /></Suspense>;
}
