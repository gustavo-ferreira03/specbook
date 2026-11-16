"use client";

import { useEffect, useState } from "react";

import { AgentPauseSettings } from "@/components/agent-pause-settings";
import { useAuth } from "@/components/auth-provider";
import { AutomationSettingsCard } from "@/components/automation-settings-card";
import { CredentialProfilesCard } from "@/components/credential-profiles-card";
import { EnvironmentsSettingsCard } from "@/components/environments-settings-card";
import { ModelSettings } from "@/components/model-settings";
import { SettingsRow, SettingsSection } from "@/components/settings-layout";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  api,
  apiPath,
  errorMessage,
  isAbortError,
  setStewardPaused,
} from "@/lib/api";
import { onInvalidate } from "@/lib/invalidation";

const ProjectPause = function ProjectPause({
  projectId,
}: {
  projectId: string;
}) {
  const { isAdmin } = useAuth();
  const [paused, setPaused] = useState<boolean | null>(null);
  const [globallyPaused, setGloballyPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const load = () =>
      (async () => {
        try {
          const resolvedValue = await api<{
            paused: boolean;
            globallyPaused: boolean;
          }>(apiPath`/projects/${projectId}/steward`, {
            signal: controller.signal,
          });
          const value = resolvedValue;
          setPaused(value.paused);
          setGloballyPaused(value.globallyPaused);
        } catch (error_) {
          if (!isAbortError(error_)) {
            setError(errorMessage(error_));
          }
        }
      })();
    load();
    const unsubscribe = onInvalidate((event) => {
      if (event.resource === "settings") {
        load();
      }
    });
    return () => {
      controller.abort();
      unsubscribe();
    };
  }, [projectId]);
  return (
    <SettingsSection id="chat-project-pause" title="Agent in this project">
      {error && (
        <Alert variant="danger" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <SettingsRow
        label={(() => {
          if (paused === null) {
            return "Loading pause settings…";
          }
          if (paused) {
            return "Paused in this project";
          }
          if (globallyPaused) {
            return "Paused across all projects";
          }
          return "Ready for events";
        })()}
        description={(() => {
          if (globallyPaused) {
            if (isAdmin) {
              return "Use Resume all projects below to allow background work to continue.";
            }
            return "An administrator needs to resume the agent across all projects.";
          }
          return "Global pause settings also apply to this project.";
        })()}
        align="center"
      >
        <Button
          variant="outline"
          disabled={busy || paused === null}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await setStewardPaused(projectId, !paused);
              setPaused(!paused);
            } catch (error_) {
              setError(errorMessage(error_));
              // oxlint-disable-next-line react/todo -- Oxlint React Compiler cannot analyze this supported JavaScript syntax; preserve its cleanup and error behavior.
            } finally {
              setBusy(false);
            }
          }}
        >
          {(() => {
            if (busy) {
              return "Saving…";
            }
            if (paused) {
              return "Resume this project";
            }
            return "Pause this project";
          })()}
        </Button>
      </SettingsRow>
    </SettingsSection>
  );
};

export const ChatSettingsDialog = function ChatSettingsDialog({
  projectId,
  tab,
  onClose,
}: {
  projectId: string;
  tab: "credentials" | "environments" | "model" | "automation";
  onClose: () => void;
}) {
  const { isAdmin } = useAuth();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-reading max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Chat settings</DialogTitle>
          <DialogDescription>
            Update access or configuration, then continue this conversation.
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue={tab}>
          <TabsList className="h-auto flex-wrap">
            <TabsTrigger value="credentials">Credentials</TabsTrigger>
            <TabsTrigger value="environments">Environments</TabsTrigger>
            <TabsTrigger value="automation">Automation</TabsTrigger>
            {isAdmin && <TabsTrigger value="model">Model</TabsTrigger>}
          </TabsList>
          <TabsContent value="credentials">
            <CredentialProfilesCard projectId={projectId} />
          </TabsContent>
          <TabsContent value="environments">
            <EnvironmentsSettingsCard projectId={projectId} />
          </TabsContent>
          <TabsContent value="automation" className="space-y-5">
            <ProjectPause projectId={projectId} />
            {isAdmin && <AgentPauseSettings />}
            <AutomationSettingsCard projectId={projectId} />
          </TabsContent>
          {isAdmin && (
            <TabsContent value="model">
              <ModelSettings />
            </TabsContent>
          )}
        </Tabs>
      </DialogContent>
    </Dialog>
  );
};
