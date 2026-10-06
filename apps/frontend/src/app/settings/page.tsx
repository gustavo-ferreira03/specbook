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
    const sections = [["model", "Model"], ["members", "Members"], ["sso", "Single sign-on"], ["security", "Agent"], ["retention", "Retention"], ["audit", "Audit log"], ["system", "System status"]];
    const tab = sections.some(([id]) => id === searchParams.get("tab")) ? searchParams.get("tab")! : "model";
    if (!isAdmin) return <main className="min-h-dvh bg-surface"><InstanceHeader /><EmptyState title="Administrator access required" description="Ask an administrator to change instance settings." /></main>;
    return <main className="min-h-dvh bg-surface">
        <InstanceHeader />
        <PageHeader title="Instance settings" description="Shared by every project on this Specbook server." width="reading" bordered={false} />
        <Tabs value={tab} onValueChange={(value) => router.replace(`/settings?tab=${value}`, { scroll: false })}>
            <div className="border-b border-line px-4 md:px-8"><TabsList aria-label="Instance settings sections" className="mx-auto w-full max-w-reading border-b-0">{sections.map(([id, label]) => <TabsTrigger key={id} value={id}>{label}</TabsTrigger>)}</TabsList></div>
            <PageContainer width="reading" className="pb-16"><TabsContent value="model"><ModelSettings /></TabsContent><TabsContent value="members"><MembersSettings /></TabsContent><TabsContent value="sso"><SsoSettings /></TabsContent><TabsContent value="security"><div className="space-y-10"><AgentPauseSettings /><SecuritySettings /></div></TabsContent><TabsContent value="retention"><RetentionSettings /></TabsContent><TabsContent value="audit"><AuditSettings /></TabsContent><TabsContent value="system"><SystemStatus /></TabsContent></PageContainer>
        </Tabs>
    </main>;
}

export default function SettingsPage() {
    return <Suspense fallback={<span className="sr-only" role="status">Loading settings</span>}><SettingsContent /></Suspense>;
}
