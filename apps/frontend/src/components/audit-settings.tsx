"use client";

import { useCallback, useEffect, useState } from "react";

import {
  InlineFeedback,
  SettingsBlock,
  SettingsSection,
} from "@/components/settings-layout";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

interface AuditEvent {
  id: string;
  actorId: string | null;
  actorName: string | null;
  actorKind: string;
  action: string;
  projectId: string | null;
  details: unknown;
  createdAt: string;
}
interface AuditResponse {
  events: AuditEvent[];
  nextBefore: string | null;
}

export const AuditSettings = function AuditSettings() {
  const [data, setData] = useState<AuditResponse | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setError("");
    try {
      setData(await api<AuditResponse>("/settings/audit?limit=50"));
    } catch (error_) {
      setError(errorMessage(error_));
    }
  }, []);
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- Reset the previous request or selection when its external key changes before loading fresh state.
    load();
  }, [load]);
  const more = async function more() {
    if (!data?.nextBefore) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      const next = await api<AuditResponse>(
        `/settings/audit?limit=50&before=${encodeURIComponent(data.nextBefore)}`
      );
      setData({
        events: [...data.events, ...next.events],
        nextBefore: next.nextBefore,
      });
    } catch (error_) {
      setError(errorMessage(error_));
      // oxlint-disable-next-line react/todo -- Oxlint React Compiler cannot analyze this supported JavaScript syntax; preserve its cleanup and error behavior.
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsSection
      id="audit-heading"
      title="Audit log"
      description="Account, project and agent actions recorded by this instance."
    >
      {error && (
        <SettingsBlock>
          <InlineFeedback feedback={{ type: "error", text: error }} />
          {!data && (
            <Button variant="outline" className="mt-3" onClick={() => load()}>
              Try again
            </Button>
          )}
        </SettingsBlock>
      )}
      {(() => {
        if (!data && !error) {
          return (
            <SettingsBlock>
              <Skeleton className="h-40 w-full" />
            </SettingsBlock>
          );
        }
        if (data) {
          if (data.events.length) {
            return (
              <ul>
                {data.events.map((event) => (
                  <li
                    key={event.id}
                    className="border-line border-b px-4 py-4 last:border-0 sm:px-5"
                  >
                    <div className="flex flex-wrap justify-between gap-2">
                      <p className="text-body text-ink font-medium">
                        {event.action.replaceAll(/[._]/gu, " ")}
                      </p>
                      <time
                        className="text-meta text-ink-subtle"
                        dateTime={event.createdAt}
                      >
                        {formatDateTime(event.createdAt, { seconds: true })}
                      </time>
                    </div>
                    <p className="text-body text-ink-muted mt-1">
                      {event.actorName ??
                        (() => {
                          if (event.actorKind === "user") {
                            return "Former member";
                          }
                          if (event.actorKind === "agent") {
                            return "Specbook agent";
                          }
                          if (event.actorKind === "ci") {
                            return "CI integration";
                          }
                          return "Specbook server";
                        })()}
                    </p>
                  </li>
                ))}
              </ul>
            );
          }
          return (
            <SettingsBlock>
              <p className="text-body text-ink-muted">
                No actions recorded yet.
              </p>
            </SettingsBlock>
          );
        }
        return null;
      })()}
      {data?.nextBefore && (
        <SettingsBlock>
          <Button variant="outline" onClick={() => more()} disabled={busy}>
            {busy ? "Loading…" : "Load older actions"}
          </Button>
        </SettingsBlock>
      )}
    </SettingsSection>
  );
};
