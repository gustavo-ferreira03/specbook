"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { InstanceHeader } from "@/components/InstanceHeader";
import { ModelSettings } from "@/components/ModelSettings";
import { PageContainer, PageHeader } from "@/components/PageHeader";
import { SystemStatus } from "@/components/SystemStatus";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

function SettingsContent() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const tab = searchParams.get("tab") === "system" ? "system" : "model";
    return <main className="min-h-dvh bg-surface">
        <InstanceHeader />
        <PageHeader title="Instance settings" description="Shared by every project on this Specbook server." width="reading" bordered={false} />
        <Tabs value={tab} onValueChange={(value) => router.replace(`/settings?tab=${value}`, { scroll: false })}>
            <div className="border-b border-line px-4 md:px-8"><TabsList aria-label="Instance settings sections" className="mx-auto w-full max-w-reading border-b-0"><TabsTrigger value="model">Model</TabsTrigger><TabsTrigger value="system">System status</TabsTrigger></TabsList></div>
            <PageContainer width="reading" className="pb-16"><TabsContent value="model"><ModelSettings /></TabsContent><TabsContent value="system"><SystemStatus /></TabsContent></PageContainer>
        </Tabs>
    </main>;
}

export default function SettingsPage() {
    return <Suspense fallback={<span className="sr-only" role="status">Loading settings</span>}><SettingsContent /></Suspense>;
}
