"use client";

import { RefreshCw, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import {
  InlineFeedback,
  SettingsBlock,
  SettingsFooter,
  SettingsRow,
  SettingsSection,
} from "@/components/settings-layout";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  deleteProject,
  getProject,
  updateProject,
  errorMessage,
} from "@/lib/api";
import type { Project } from "@/lib/types";

export const ProjectSettingsCard = function ProjectSettingsCard({
  projectId,
  children,
}: {
  projectId: string;
  children?: React.ReactNode;
}) {
  const router = useRouter();
  const [project, setProject] = useState<Project | null>(null);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const deleteTriggerRef = useRef<HTMLElement | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await getProject(projectId);
      setProject(result.project);
      setName(result.project.name);
    } catch (error_) {
      setError(errorMessage(error_));
      // oxlint-disable-next-line react/todo -- Oxlint React Compiler cannot analyze this supported JavaScript syntax; preserve its cleanup and error behavior.
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- Reset the previous request or selection when its external key changes before loading fresh state.
    refresh();
  }, [refresh]);

  const dirty = project !== null && name.trim() !== project.name;

  const save = async function save() {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const result = await updateProject(projectId, { name: name.trim() });
      setProject(result.project);
      setName(result.project.name);
      setSaved(true);
    } catch (error_) {
      setError(errorMessage(error_));
      // oxlint-disable-next-line react/todo -- Oxlint React Compiler cannot analyze this supported JavaScript syntax; preserve its cleanup and error behavior.
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async function confirmDelete() {
    setDeleting(true);
    setDeleteError("");
    try {
      await deleteProject(projectId);
      router.push("/");
    } catch (error_) {
      setDeleteError(errorMessage(error_));
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-10">
      <SettingsSection id="project-settings-heading" title="Project">
        {loading && (
          <output
            className="block"
            aria-label="Loading project settings"
            aria-busy="true"
          >
            {[0].map((row) => (
              <SettingsBlock
                key={row}
                className="grid gap-3 md:grid-cols-[13rem_1fr] md:gap-8"
              >
                <Skeleton className="h-4 w-24 md:mt-2.5" />
                <Skeleton className="h-9" />
              </SettingsBlock>
            ))}
          </output>
        )}
        {!loading && !project && error && (
          <SettingsBlock>
            <Alert variant="danger" role="alert">
              <AlertTitle>Project settings could not load</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => refresh()}
            >
              <RefreshCw size={14} /> Try again
            </Button>
          </SettingsBlock>
        )}
        {!loading && project && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <SettingsRow label="Project name" htmlFor="project-name">
              <Input
                id="project-name"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setSaved(false);
                }}
                disabled={saving}
                autoComplete="off"
              />
            </SettingsRow>
            <SettingsFooter
              feedback={
                /* oxlint-disable react/no-unstable-nested-components -- This function is immediately evaluated to supply a ReactNode prop, not mounted as a nested component. */
                (() => {
                  if (error) {
                    return (
                      <InlineFeedback
                        feedback={{ type: "error", text: error }}
                      />
                    );
                  }
                  if (saved && !dirty) {
                    return (
                      <InlineFeedback
                        feedback={{ type: "success", text: "Project saved." }}
                      />
                    );
                  }
                  if (dirty) {
                    return (
                      <span className="text-control text-ink-muted">
                        Unsaved changes
                      </span>
                    );
                  }
                  return null;
                })()
                /* oxlint-enable react/no-unstable-nested-components */
              }
            >
              {dirty && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setName(project.name);
                    setError("");
                  }}
                  disabled={saving}
                >
                  Cancel
                </Button>
              )}
              <Button type="submit" disabled={saving || !dirty || !name.trim()}>
                {saving ? "Saving…" : "Save changes"}
              </Button>
            </SettingsFooter>
          </form>
        )}
      </SettingsSection>

      {children}

      {!loading && project && (
        <SettingsSection
          id="danger-zone-heading"
          title="Danger zone"
          tone="danger"
        >
          <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:px-5">
            <div className="min-w-0">
              <p className="text-control text-ink font-medium">
                Delete this project
              </p>
              <p className="text-meta text-ink-muted mt-0.5 max-w-[60ch]">
                Permanently removes every Feature, Spec, run, chat, and
                credential in this project, along with its repository. This
                cannot be undone.
              </p>
            </div>
            <Button
              type="button"
              variant="destructive-soft"
              className="self-start sm:self-auto"
              onClick={(event) => {
                deleteTriggerRef.current = event.currentTarget;
                setDeleteError("");
                setDeleteOpen(true);
              }}
            >
              <Trash2 size={14} /> Delete project
            </Button>
          </div>
        </SettingsSection>
      )}

      {project && (
        <ConfirmDeleteDialog
          open={deleteOpen}
          title="Delete project?"
          description={
            <>
              <strong className="text-ink font-semibold">{project.name}</strong>{" "}
              and everything in it will be permanently removed: every Feature,
              Spec, run history, evidence, chat, and saved credential. The local
              repository is deleted too.
            </>
          }
          confirmLabel="Delete project"
          busy={deleting}
          error={deleteError}
          returnFocusRef={deleteTriggerRef}
          onCancel={() => {
            setDeleteOpen(false);
            setDeleteError("");
          }}
          onConfirm={() => confirmDelete()}
        />
      )}
    </div>
  );
};
