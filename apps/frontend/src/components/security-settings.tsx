"use client";

import { useCallback, useEffect, useState } from "react";

import {
  InlineFeedback,
  SettingsBlock,
  SettingsFooter,
  SettingsRow,
  SettingsSection,
} from "@/components/settings-layout";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { api, errorMessage } from "@/lib/api";

interface SecurityConfig {
  sendScreenshotsToModel: boolean;
}

export const SecuritySettings = function SecuritySettings() {
  const [settings, setSettings] = useState<SecurityConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);
  const load = useCallback(async () => {
    try {
      setSettings(await api<SecurityConfig>("/settings/security"));
    } catch (error) {
      setFeedback({ type: "error", text: errorMessage(error) });
    }
  }, []);
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- Reset the previous request or selection when its external key changes before loading fresh state.
    load();
  }, [load]);
  const save = async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!settings) {
      return;
    }
    setBusy(true);
    setFeedback(null);
    try {
      setSettings(
        await api<SecurityConfig>("/settings/security", {
          method: "PUT",
          body: JSON.stringify(settings),
        })
      );
      setFeedback({ type: "success", text: "Agent safety settings saved." });
    } catch (error) {
      setFeedback({ type: "error", text: errorMessage(error) });
      // oxlint-disable-next-line react/todo -- Oxlint React Compiler cannot analyze this supported JavaScript syntax; preserve its cleanup and error behavior.
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsSection id="agent-safety-heading" title="Agent safety">
      {settings ? (
        <form onSubmit={save}>
          <SettingsRow
            label="Screenshots sent to model"
            htmlFor="model-screenshots"
            description="When disabled, screenshots remain local run evidence and are not sent to the model provider."
          >
            <Select
              value={settings.sendScreenshotsToModel ? "enabled" : "disabled"}
              onValueChange={(value) =>
                setSettings({
                  ...settings,
                  sendScreenshotsToModel: value === "enabled",
                })
              }
              disabled={busy}
            >
              <SelectTrigger id="model-screenshots">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="enabled">Enabled</SelectItem>
                <SelectItem value="disabled">Disabled</SelectItem>
              </SelectContent>
            </Select>
          </SettingsRow>
          <SettingsFooter feedback={<InlineFeedback feedback={feedback} />}>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save safety settings"}
            </Button>
          </SettingsFooter>
        </form>
      ) : (
        <SettingsBlock>
          {feedback ? (
            <>
              <InlineFeedback feedback={feedback} />
              <Button
                type="button"
                variant="outline"
                className="mt-3"
                onClick={() => load()}
              >
                Try again
              </Button>
            </>
          ) : (
            <Skeleton className="h-32 w-full" />
          )}
        </SettingsBlock>
      )}
    </SettingsSection>
  );
};
