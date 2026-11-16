"use client";

import { Pause, Play, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import {
  InlineFeedback,
  SettingsBlock,
  SettingsFooter,
  SettingsRow,
  SettingsSection,
} from "@/components/settings-layout";
import type { InlineFeedbackValue } from "@/components/settings-layout";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, isAbortError } from "@/lib/api";
import { invalidate } from "@/lib/invalidation";

export const AgentPauseSettings = function AgentPauseSettings() {
  const [paused, setPaused] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<InlineFeedbackValue | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    // oxlint-disable-next-line react/set-state-in-effect -- Reset the previous request or selection when its external key changes before loading fresh state.
    setLoadError("");
    (async () => {
      try {
        const resolvedValue = await api<{ paused: boolean }>(
          "/settings/agent",
          { signal: controller.signal }
        );
        const result = resolvedValue;
        return setPaused(result.paused);
      } catch (error) {
        if (!isAbortError(error)) {
          setLoadError("The agent pause setting could not load. Try again.");
        }
      }
    })();
    return () => controller.abort();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- This dependency intentionally triggers a retry, navigation reset, or DOM measurement without being read by the effect.
  }, [retryKey]);

  const toggle = async function toggle() {
    if (paused === null) {
      return;
    }
    setSaving(true);
    setFeedback(null);
    try {
      const result = await api<{ paused: boolean }>("/settings/agent", {
        method: "PUT",
        body: JSON.stringify({ paused: !paused }),
      });
      setPaused(result.paused);
      invalidate({ resource: "settings" });
      setFeedback({
        type: "success",
        text: result.paused
          ? "Specbook is paused across all projects. Current work will stop safely."
          : "Specbook has resumed. Projects paused individually stay paused.",
      });
    } catch {
      setFeedback({
        type: "error",
        text: "The pause setting could not be saved. Try again in a moment.",
      });
      // oxlint-disable-next-line react/todo -- Oxlint React Compiler cannot analyze this supported JavaScript syntax; preserve its cleanup and error behavior.
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection
      id="agent-pause-heading"
      title="Agent across all projects"
      description="Shared by every project on this server. Project pauses remain separate."
    >
      {(() => {
        if (loadError) {
          return (
            <SettingsBlock>
              <Alert variant="danger" role="alert">
                <AlertDescription>{loadError}</AlertDescription>
              </Alert>
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => setRetryKey((key) => key + 1)}
              >
                <RefreshCw size={14} /> Try again
              </Button>
            </SettingsBlock>
          );
        }
        if (paused === null) {
          return (
            <SettingsBlock aria-busy="true">
              <Skeleton className="h-9 w-full" />
            </SettingsBlock>
          );
        }
        return (
          <SettingsRow
            label={paused ? "Paused by you" : "Ready for events"}
            description="Pausing stops new work and lets current work stop safely."
            align="center"
          >
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => toggle()}
            >
              {paused ? <Play size={14} /> : <Pause size={14} />}
              {(() => {
                if (saving) {
                  return "Saving…";
                }
                if (paused) {
                  return "Resume all projects";
                }
                return "Pause all projects";
              })()}
            </Button>
          </SettingsRow>
        );
      })()}
      {feedback && (
        <SettingsFooter feedback={<InlineFeedback feedback={feedback} />} />
      )}
    </SettingsSection>
  );
};
