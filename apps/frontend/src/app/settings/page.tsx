"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/components/AuthProvider";
import { AccessTokensSettings } from "@/components/AccessTokensSettings";
import { RunnersSettings } from "@/components/RunnersSettings";
import { MembersSettings } from "@/components/MembersSettings";
import { SsoSettings } from "@/components/SsoSettings";
import { AgentPauseSettings } from "@/components/AgentPauseSettings";
import { SecuritySettings } from "@/components/SecuritySettings";
import { RetentionSettings } from "@/components/RetentionSettings";
import { AuditSettings } from "@/components/AuditSettings";
import { InstanceHeader } from "@/components/InstanceHeader";
import { ModelSettings } from "@/components/ModelSettings";
import { PageContainer, PageHeader } from "@/components/PageHeader";
import { SystemStatus } from "@/components/SystemStatus";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

function SettingsContent() {
    const { isAdmin } = useAuth();
    const router = useRouter();
    const searchParams = useSearchParams();
    const sections = [...(isAdmin ? [["model", "Model"], ["access", "Access"], ["agent", "Agent"], ["runners", "Runners"], ["system", "System"]] : []), ["access-tokens", "Access tokens"]];
    const requested = searchParams.get("tab") ?? "";
    const tab = sections.some(([id]) => id === requested) ? requested : isAdmin ? "model" : "access-tokens";
    return <main className="min-h-dvh bg-surface">
        <InstanceHeader />
        <PageHeader title={isAdmin ? "Instance settings" : "Settings"} description={isAdmin ? "Instance configuration and your personal access tokens." : "Manage your account's access to Specbook."} width="reading" bordered={false} />
        <Tabs value={tab} onValueChange={(value) => router.replace(`/settings?tab=${value}`, { scroll: false })}>
            {sections.length > 1 && <div className="border-b border-line px-4 md:px-8"><div className="mx-auto w-full max-w-reading"><TabsList aria-label="Instance settings sections" className="min-w-0 flex-wrap gap-y-2 overflow-visible border-b-0">{sections.map(([id, label]) => <TabsTrigger key={id} value={id}>{label}</TabsTrigger>)}</TabsList></div></div>}
            <PageContainer width="reading" className="pb-16">{isAdmin ? <><TabsContent value="model"><ModelSettings /></TabsContent><TabsContent value="access"><div className="space-y-10"><MembersSettings /><SsoSettings /></div></TabsContent><TabsContent value="agent"><div className="space-y-10"><AgentPauseSettings /><SecuritySettings /><RetentionSettings /></div></TabsContent><TabsContent value="runners"><RunnersSettings /></TabsContent><TabsContent value="system"><div className="space-y-10"><SystemStatus /><AuditSettings /></div></TabsContent><TabsContent value="access-tokens"><AccessTokensSettings /></TabsContent></> : <AccessTokensSettings />}</PageContainer>
        </Tabs>
    </main>;
}

export default function SettingsPage() {
    return <Suspense fallback={<span className="sr-only" role="status">Loading settings</span>}><SettingsContent /></Suspense>;
}
