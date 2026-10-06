"use client";

import Link from "next/link";
import { usePathname, useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Settings } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/PageHeader";
import { ContextFileCard } from "@/components/ContextFileCard";
import { CredentialProfilesCard } from "@/components/CredentialProfilesCard";
import { GitRemoteAccess } from "@/components/GitRemoteAccess";
import { RepositoryRecovery } from "@/components/RepositoryRecovery";
import { ProjectSettingsCard } from "@/components/ProjectSettingsCard";
import { AutomationSettingsCard } from "@/components/AutomationSettingsCard";
import { CiSettingsCard } from "@/components/CiSettingsCard";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getProject } from "@/lib/api";
import { matchesInvalidation, onInvalidate } from "@/lib/invalidation";

const SETTINGS_TABS = ["general", "git", "context", "credentials", "automation", "ci"] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number];
const TAB_LABELS: [SettingsTab, string][] = [["general", "General"], ["git", "Git"], ["context", "Context"], ["credentials", "Credentials"], ["automation", "Automation"], ["ci", "CI/CD"]];

function SettingsContent() {
    const { projectId } = useParams<{ projectId: string }>();
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const tab = searchParams.get("tab");
    const activeTab = SETTINGS_TABS.includes(tab as SettingsTab) ? tab as SettingsTab : "general";
    const [projectName, setProjectName] = useState<string | null>(null);
    const [gitToken, setGitToken] = useState<string | null>(null);
    const [ciToken, setCiToken] = useState<{ projectId: string; token: string | null } | null>(null);

    useEffect(() => {
        let active = true;
        const load = () => { void getProject(projectId).then(({ project }) => { if (active) setProjectName(project.name); }).catch(() => undefined); };
        load();
        const unsubscribe = onInvalidate((event) => { if (matchesInvalidation(event, "projects", projectId)) load(); });
        return () => { active = false; unsubscribe(); };
    }, [projectId]);

    function selectTab(value: string) {
        const params = new URLSearchParams(searchParams.toString());
        if (value === "general") params.delete("tab");
        else params.set("tab", value);
        router.replace(params.size ? `${pathname}?${params}` : pathname, { scroll: false });
    }

    return <div className="flex min-h-full flex-col bg-surface">
        <PageHeader title="Project settings" breadcrumbs={[{ label: projectName ?? "Project", href: `/p/${projectId}` }]} width="reading" bordered={false} className="pb-2 md:pb-3"
            actions={<Button asChild variant="ghost"><Link href="/settings"><Settings size={14} /> Instance settings</Link></Button>} />
        <Tabs value={activeTab} onValueChange={selectTab} className="flex-1">
            <div className="border-b border-line bg-surface px-4 md:px-8">
                <TabsList aria-label="Project settings sections" className="mx-auto w-full max-w-reading border-b-0">
                    {TAB_LABELS.map(([value, label]) => <TabsTrigger key={value} value={value}>{label}</TabsTrigger>)}
                </TabsList>
            </div>
            <PageContainer width="reading" className="pb-16">
                <TabsContent value="general"><ProjectSettingsCard projectId={projectId} /></TabsContent>
                <TabsContent value="git"><div className="space-y-10"><RepositoryRecovery projectId={projectId} /><GitRemoteAccess projectId={projectId} oneTimeToken={gitToken} onOneTimeTokenChange={setGitToken} /></div></TabsContent>
                <TabsContent value="context"><ContextFileCard projectId={projectId} /></TabsContent>
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
