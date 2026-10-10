"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/components/AuthProvider";
import { EmptyState } from "@/components/EmptyState";
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
    const sections = [["model", "Model"], ["access", "Access"], ["agent", "Agent"], ["system", "System"]];
    const requested = searchParams.get("tab") ?? "";
    const tab = sections.some(([id]) => id === requested) ? requested : "model";
    if (!isAdmin) return <main className="min-h-dvh bg-surface"><InstanceHeader /><EmptyState title="Administrator access required" description="Ask an administrator to change instance settings." /></main>;
    return <main className="min-h-dvh bg-surface">
        <InstanceHeader />
        <PageHeader title="Instance settings" description="Shared by every project on this Specbook server." width="reading" bordered={false} />
        <Tabs value={tab} onValueChange={(value) => router.replace(`/settings?tab=${value}`, { scroll: false })}>
            <div className="border-b border-line px-4 md:px-8"><div className="mx-auto w-full max-w-reading"><TabsList aria-label="Instance settings sections" className="min-w-0 border-b-0">{sections.map(([id, label]) => <TabsTrigger key={id} value={id}>{label}</TabsTrigger>)}</TabsList></div></div>
            <PageContainer width="reading" className="pb-16"><TabsContent value="model"><ModelSettings /></TabsContent><TabsContent value="access"><div className="space-y-10"><MembersSettings /><SsoSettings /></div></TabsContent><TabsContent value="agent"><div className="space-y-10"><AgentPauseSettings /><SecuritySettings /><RetentionSettings /></div></TabsContent><TabsContent value="system"><div className="space-y-10"><SystemStatus /><AuditSettings /></div></TabsContent></PageContainer>
        </Tabs>
    </main>;
}

export default function SettingsPage() {
    return <Suspense fallback={<span className="sr-only" role="status">Loading settings</span>}><SettingsContent /></Suspense>;
}
