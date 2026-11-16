"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";

import { AccessTokensSettings } from "@/components/access-tokens-settings";
import { AgentPauseSettings } from "@/components/agent-pause-settings";
import { AuditSettings } from "@/components/audit-settings";
import { useAuth } from "@/components/auth-provider";
import { InstanceHeader } from "@/components/instance-header";
import { MembersSettings } from "@/components/members-settings";
import { ModelSettings } from "@/components/model-settings";
import { PageContainer, PageHeader } from "@/components/page-header";
import { RetentionSettings } from "@/components/retention-settings";
import { RunnersSettings } from "@/components/runners-settings";
import { SecuritySettings } from "@/components/security-settings";
import { SsoSettings } from "@/components/sso-settings";
import { SystemStatus } from "@/components/system-status";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const SettingsContent = function SettingsContent() {
  const { isAdmin } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const sections = [
    ...(isAdmin
      ? [
          ["model", "Model"],
          ["access", "Access"],
          ["agent", "Agent"],
          ["runners", "Runners"],
          ["system", "System"],
        ]
      : []),
    ["access-tokens", "Access tokens"],
  ];
  const requested = searchParams.get("tab") ?? "";
  const tab = (() => {
    if (sections.some(([id]) => id === requested)) {
      return requested;
    }
    if (isAdmin) {
      return "model";
    }
    return "access-tokens";
  })();
  return (
    <main className="bg-surface min-h-dvh">
      <InstanceHeader />
      <PageHeader
        title={isAdmin ? "Instance settings" : "Settings"}
        description={
          isAdmin
            ? "Instance configuration and your personal access tokens."
            : "Manage your account's access to Specbook."
        }
        width="reading"
        bordered={false}
      />
      <Tabs
        value={tab}
        onValueChange={(value) =>
          router.replace(`/settings?tab=${value}`, { scroll: false })
        }
      >
        {sections.length > 1 && (
          <div className="border-line border-b px-4 md:px-8">
            <div className="max-w-reading mx-auto w-full">
              <TabsList
                aria-label="Instance settings sections"
                className="min-w-0 flex-wrap gap-y-2 overflow-visible border-b-0"
              >
                {sections.map(([id, label]) => (
                  <TabsTrigger key={id} value={id}>
                    {label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>
          </div>
        )}
        <PageContainer width="reading" className="pb-16">
          {isAdmin ? (
            <>
              <TabsContent value="model">
                <ModelSettings />
              </TabsContent>
              <TabsContent value="access">
                <div className="space-y-10">
                  <MembersSettings />
                  <SsoSettings />
                </div>
              </TabsContent>
              <TabsContent value="agent">
                <div className="space-y-10">
                  <AgentPauseSettings />
                  <SecuritySettings />
                  <RetentionSettings />
                </div>
              </TabsContent>
              <TabsContent value="runners">
                <RunnersSettings />
              </TabsContent>
              <TabsContent value="system">
                <div className="space-y-10">
                  <SystemStatus />
                  <AuditSettings />
                </div>
              </TabsContent>
              <TabsContent value="access-tokens">
                <AccessTokensSettings />
              </TabsContent>
            </>
          ) : (
            <AccessTokensSettings />
          )}
        </PageContainer>
      </Tabs>
    </main>
  );
};

const SettingsPage = function SettingsPage() {
  return (
    <Suspense fallback={<output className="sr-only">Loading settings</output>}>
      <SettingsContent />
    </Suspense>
  );
};
export default SettingsPage;
