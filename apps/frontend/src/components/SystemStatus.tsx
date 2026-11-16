"use client";

import { AlertCircle, Check, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  InlineFeedback,
  SettingsBlock,
  SettingsSection,
} from "@/components/SettingsLayout";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { API_URL, errorMessage, SERVER_UNREACHABLE_MESSAGE } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { SystemReadiness } from "@/lib/types";

export function SystemStatus() {
  const [status, setStatus] = useState<SystemReadiness | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`${API_URL}/ready`, {
        credentials: "include",
      });
      if (response.status !== 200 && response.status !== 503) {
        throw new Error("System status could not load. Try again.");
      }
      setStatus((await response.json()) as SystemReadiness);
    } catch (reason) {
      setError(
        reason instanceof TypeError
          ? SERVER_UNREACHABLE_MESSAGE
          : errorMessage(reason)
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <SettingsSection
      id="system-status-heading"
      title="System status"
      description="Checks the services needed to save work and run the browser."
      actions={
        <Button
          variant="outline"
          onClick={() => void load()}
          disabled={loading}
        >
          <RefreshCw
            size={14}
            className={
              loading ? "animate-spin motion-reduce:animate-none" : undefined
            }
          />{" "}
          {loading ? "Checking…" : "Check again"}
        </Button>
      }
    >
      {error && (
        <SettingsBlock>
          <InlineFeedback feedback={{ type: "error", text: error }} />
        </SettingsBlock>
      )}
      {!status && loading && (
        <SettingsBlock>
          <div
            className="space-y-4"
            role="status"
            aria-label="Checking system status"
          >
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-5 w-64" />
            <Skeleton className="h-5 w-40" />
          </div>
        </SettingsBlock>
      )}
      {status && (
        <>
          <ul>
            {status.checks.map((check) => (
              <li
                key={check.id}
                className="border-line flex gap-3 border-b px-4 py-4 last:border-b-0 sm:px-5"
              >
                {check.ok ? (
                  <Check
                    size={16}
                    className="text-success mt-0.5 shrink-0"
                    aria-label="Ready"
                  />
                ) : (
                  <AlertCircle
                    size={16}
                    className="text-danger mt-0.5 shrink-0"
                    aria-label="Needs attention"
                  />
                )}
                <div className="min-w-0">
                  <p className="text-body text-ink font-medium">
                    {check.label}
                  </p>
                  <p className="text-body text-ink-muted">{check.message}</p>
                  {!check.ok && check.nextStep && (
                    <p className="text-body text-ink mt-1">{check.nextStep}</p>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <div className="border-line bg-surface-soft text-meta text-ink-subtle border-t px-4 py-3 sm:px-5">
            Checked {formatDateTime(status.checkedAt)}
          </div>
        </>
      )}
    </SettingsSection>
  );
}
