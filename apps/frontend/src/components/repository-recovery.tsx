"use client";

import { AlertCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { FileDiff } from "@/components/file-diff";
import type { ProposalFile } from "@/components/file-diff";
import {
  InlineFeedback,
  SettingsBlock,
  SettingsSection,
} from "@/components/settings-layout";
import type { InlineFeedbackValue } from "@/components/settings-layout";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { api, apiPath, errorMessage } from "@/lib/api";
import { countLabel } from "@/lib/format";

interface Recovery {
  dirty: boolean;
  blocked: boolean;
  fingerprint: string;
  files: (ProposalFile & { deleted: boolean })[];
  canSave: boolean;
  message: string;
}

export const RepositoryRecovery =
  /* oxlint-disable eslint/complexity -- Keep the existing render states and their coordinated actions together during the lint migration. */
  function RepositoryRecovery({ projectId }: { projectId: string }) {
    const [recovery, setRecovery] = useState<Recovery | null>(null);
    const [open, setOpen] = useState(false);
    const [saving, setSaving] = useState(false);
    const [loading, setLoading] = useState(false);
    const [feedback, setFeedback] = useState<InlineFeedbackValue | null>(null);
    const trigger = useRef<HTMLButtonElement | null>(null);
    const load = useCallback(async () => {
      setLoading(true);
      try {
        setRecovery(
          await api<Recovery>(
            apiPath`/projects/${projectId}/repository/recovery`
          )
        );
      } catch (error) {
        setFeedback({ type: "error", text: errorMessage(error) });
        // oxlint-disable-next-line react/todo -- Oxlint React Compiler cannot analyze this supported JavaScript syntax; preserve its cleanup and error behavior.
      } finally {
        setLoading(false);
      }
    }, [projectId]);

    useEffect(() => {
      // oxlint-disable-next-line react/set-state-in-effect -- Reset the previous request or selection when its external key changes before loading fresh state.
      load();
    }, [load]);

    const save = async function save() {
      if (!recovery?.canSave) {
        return;
      }
      setSaving(true);
      setFeedback(null);
      try {
        const result = await api<{ message: string }>(
          apiPath`/projects/${projectId}/repository/recovery`,
          {
            method: "POST",
            body: JSON.stringify({ fingerprint: recovery.fingerprint }),
          }
        );
        setFeedback({ type: "success", text: result.message });
        setOpen(false);
        await load();
      } catch (error) {
        setFeedback({ type: "error", text: errorMessage(error) });
        // oxlint-disable-next-line react/todo -- Oxlint React Compiler cannot analyze this supported JavaScript syntax; preserve its cleanup and error behavior.
      } finally {
        setSaving(false);
      }
    };

    if (!recovery?.dirty && !recovery?.blocked && !feedback) {
      return null;
    }
    return (
      <>
        <SettingsSection
          id="pending-edits-heading"
          title={
            recovery?.blocked
              ? "Project files need attention"
              : "Pending file edits"
          }
          description="Review changes made directly to this project's files before running checks."
        >
          <SettingsBlock>
            {(recovery?.dirty || recovery?.blocked) && (
              <p className="text-body text-ink-muted mb-3">
                {recovery.message}
              </p>
            )}
            <InlineFeedback feedback={feedback} />
            {recovery?.canSave && (
              <Button
                ref={trigger}
                variant="outline"
                className="mt-2"
                onClick={() => {
                  setFeedback(null);
                  setOpen(true);
                }}
              >
                Review {countLabel(recovery.files.length, "changed file")}
              </Button>
            )}
            {!recovery?.canSave && feedback?.type === "error" && (
              <Button
                variant="outline"
                className="mt-2"
                onClick={() => load()}
                disabled={loading}
              >
                <RefreshCw size={14} /> Try again
              </Button>
            )}
          </SettingsBlock>
        </SettingsSection>
        <Sheet
          open={open}
          onOpenChange={(value) => {
            if (!saving) {
              setOpen(value);
            }
          }}
        >
          <SheetContent
            className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              trigger.current?.focus();
            }}
          >
            <SheetHeader className="border-line border-b px-5 py-5 pr-12">
              <SheetTitle>Save pending edits?</SheetTitle>
              <SheetDescription>
                Review every file below. Saving commits these changes to the
                project, including any changes to its expected behavior.
              </SheetDescription>
            </SheetHeader>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-5">
              {recovery?.files.map((file) => (
                <div key={file.path}>
                  {file.deleted && (
                    <p className="text-body text-danger mb-1">
                      This file will be deleted.
                    </p>
                  )}
                  <FileDiff file={file} />
                </div>
              ))}
            </div>
            <div className="border-line bg-surface-soft space-y-3 border-t px-5 py-4">
              <InlineFeedback feedback={feedback} />
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() => load()}
                  disabled={saving || loading}
                >
                  <RefreshCw size={14} /> Refresh changes
                </Button>
                <Button
                  onClick={() => save()}
                  disabled={saving || loading || !recovery?.canSave}
                >
                  {saving ? "Saving…" : "Save pending edits"}
                </Button>
              </div>
              <p className="text-meta text-ink-subtle flex items-start gap-2">
                <AlertCircle size={13} className="mt-0.5 shrink-0" />
                Saving preserves the edited files. Specbook does not discard or
                rewrite your changes.
              </p>
            </div>
          </SheetContent>
        </Sheet>
      </>
    );
  };
/* oxlint-enable eslint/complexity */
