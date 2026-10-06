"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { AgentPauseSettings } from "@/components/AgentPauseSettings";
import { AutomationSettingsCard } from "@/components/AutomationSettingsCard";
import { CredentialProfilesCard } from "@/components/CredentialProfilesCard";
import { EnvironmentsSettingsCard } from "@/components/EnvironmentsSettingsCard";
import { ModelSettings } from "@/components/ModelSettings";
import { SettingsRow, SettingsSection } from "@/components/SettingsLayout";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, apiPath, errorMessage, isAbortError, setStewardPaused } from "@/lib/api";
import { onInvalidate } from "@/lib/invalidation";

function ProjectPause({ projectId }: { projectId: string }) {
    const { isAdmin } = useAuth();
    const [paused, setPaused] = useState<boolean | null>(null);
    const [globallyPaused, setGloballyPaused] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    useEffect(() => {
        const controller = new AbortController();
        const load = () => api<{ paused: boolean; globallyPaused: boolean }>(apiPath`/projects/${projectId}/steward`, { signal: controller.signal }).then((value) => { setPaused(value.paused); setGloballyPaused(value.globallyPaused); }).catch((error) => { if (!isAbortError(error)) setError(errorMessage(error)); });
        void load();
        const unsubscribe = onInvalidate((event) => { if (event.resource === "settings") void load(); });
        return () => { controller.abort(); unsubscribe(); };
    }, [projectId]);
    return <SettingsSection id="chat-project-pause" title="Agent in this project">
        {error && <Alert variant="danger" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
        <SettingsRow label={paused === null ? "Loading pause settings…" : paused ? "Paused in this project" : globallyPaused ? "Paused across all projects" : "Ready for events"} description={globallyPaused ? isAdmin ? "Use Resume all projects below to allow background work to continue." : "An administrator needs to resume the agent across all projects." : "Global pause settings also apply to this project."} align="center">
            <Button variant="outline" disabled={busy || paused === null} onClick={async () => {
                setBusy(true);
                setError("");
                try { await setStewardPaused(projectId, !paused); setPaused(!paused); }
                catch (error) { setError(errorMessage(error)); }
                finally { setBusy(false); }
            }}>{busy ? "Saving…" : paused ? "Resume this project" : "Pause this project"}</Button>
        </SettingsRow>
    </SettingsSection>;
}

export function ChatSettingsDialog({ projectId, tab, onClose }: { projectId: string; tab: "credentials" | "environments" | "model" | "automation"; onClose: () => void }) {
    const { isAdmin } = useAuth();
    return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-reading">
            <DialogHeader><DialogTitle>Chat settings</DialogTitle><DialogDescription>Update access or configuration, then continue this conversation.</DialogDescription></DialogHeader>
            <Tabs defaultValue={tab}>
                <TabsList className="h-auto flex-wrap"><TabsTrigger value="credentials">Credentials</TabsTrigger><TabsTrigger value="environments">Environments</TabsTrigger><TabsTrigger value="automation">Automation</TabsTrigger>{isAdmin && <TabsTrigger value="model">Model</TabsTrigger>}</TabsList>
                <TabsContent value="credentials"><CredentialProfilesCard projectId={projectId} /></TabsContent>
                <TabsContent value="environments"><EnvironmentsSettingsCard projectId={projectId} /></TabsContent>
                <TabsContent value="automation" className="space-y-5"><ProjectPause projectId={projectId} />{isAdmin && <AgentPauseSettings />}<AutomationSettingsCard projectId={projectId} /></TabsContent>
                {isAdmin && <TabsContent value="model"><ModelSettings /></TabsContent>}
            </Tabs>
        </DialogContent>
    </Dialog>;
}
