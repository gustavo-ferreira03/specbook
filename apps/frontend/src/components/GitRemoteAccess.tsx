"use client";

import {
  AlertCircle,
  Check,
  Clipboard,
  GitBranch,
  KeyRound,
  RefreshCw,
  RotateCw,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { RelativeTime } from "@/components/RelativeTime";
import {
  InlineFeedback,
  SettingsBlock,
  SettingsFooter,
  SettingsRow,
  SettingsSection,
} from "@/components/SettingsLayout";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  getProjectGitRemote,
  issueProjectGitRemoteToken,
  revokeProjectGitRemoteToken,
} from "@/lib/api";
import { copyText, selectElementText } from "@/lib/clipboard";
import type { GitRemoteAccess } from "@/lib/types";
import { cn } from "@/lib/utils";

type TokenConfirmation = "rotate" | "revoke";

export function GitRemoteAccess({
  projectId,
  oneTimeToken,
  onOneTimeTokenChange,
}: {
  projectId: string;
  oneTimeToken: string | null;
  onOneTimeTokenChange: (token: string | null) => void;
}) {
  const [remote, setRemote] = useState<GitRemoteAccess | null>(null);
  const [copied, setCopied] = useState<"url" | "token" | null>(null);
  const [copyError, setCopyError] = useState<"url" | "token" | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmation, setConfirmation] = useState<TokenConfirmation | null>(
    null
  );
  const [confirmError, setConfirmError] = useState("");
  const urlRef = useRef<HTMLElement | null>(null);
  const tokenRef = useRef<HTMLElement | null>(null);
  const confirmTriggerRef = useRef<HTMLElement | null>(null);

  async function refresh() {
    const result = await getProjectGitRemote(projectId);
    setRemote(result.remote);
  }

  useEffect(() => {
    let active = true;
    getProjectGitRemote(projectId)
      .then((result) => {
        if (active) {
          setRemote(result.remote);
        }
      })
      .catch((caught: Error) => {
        if (active) {
          setError(caught.message);
        }
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  async function run(
    key: string,
    action: () => Promise<void>,
    success: string
  ) {
    setBusy(key);
    setError("");
    setNotice("");
    try {
      await action();
      await refresh();
      setNotice(success);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy("");
    }
  }

  async function copy(value: string, kind: "url" | "token") {
    if (await copyText(value)) {
      setCopyError(null);
      setCopied(kind);
      window.setTimeout(
        () => setCopied((current) => (current === kind ? null : current)),
        1800
      );
      return;
    }
    setCopied(null);
    setCopyError(kind);
    selectElementText(kind === "url" ? urlRef.current : tokenRef.current);
  }

  async function issueToken() {
    await run(
      "issue",
      async () => {
        const result = await issueProjectGitRemoteToken(projectId);
        onOneTimeTokenChange(result.token);
      },
      "Access token created."
    );
  }

  async function confirmTokenAction() {
    if (!confirmation) {
      return;
    }
    setConfirmError("");
    const action = confirmation;
    setBusy(action === "rotate" ? "issue" : "revoke");
    try {
      if (action === "rotate") {
        const result = await issueProjectGitRemoteToken(projectId);
        onOneTimeTokenChange(result.token);
      } else {
        await revokeProjectGitRemoteToken(projectId);
        onOneTimeTokenChange(null);
      }
      setConfirmation(null);
      setError("");
      setNotice(
        action === "rotate"
          ? "Access token rotated. The previous token no longer works."
          : "Access token revoked."
      );
      await refresh().catch(() => undefined);
    } catch (caught) {
      setConfirmError(
        caught instanceof Error ? caught.message : String(caught)
      );
    } finally {
      setBusy("");
    }
  }

  function openConfirmation(action: TokenConfirmation, trigger: HTMLElement) {
    confirmTriggerRef.current = trigger;
    setConfirmError("");
    setConfirmation(action);
  }

  if (!remote && !error) {
    return (
      <section
        aria-label="Loading Specbook repository access"
        aria-busy="true"
        role="status"
      >
        <Skeleton className="mb-2 h-5 w-44" />
        <Skeleton className="mb-4 h-3.5 w-72" />
        <div className="sheet rounded-xl">
          {[0, 1, 2].map((row) => (
            <div
              key={row}
              className="border-line grid gap-3 border-b px-5 py-4 last:border-0 md:grid-cols-[13rem_1fr] md:gap-8"
            >
              <Skeleton className="h-4 w-24 md:mt-2.5" />
              <Skeleton className="h-9" />
            </div>
          ))}
        </div>
      </section>
    );
  }

  if (!remote) {
    return (
      <Alert variant="danger" role="alert">
        <AlertTitle>Repository access unavailable</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  const { hasToken } = remote.token;

  return (
    <>
      <SettingsSection
        id="specbook-repository-heading"
        title="Specbook repository"
        description="Clone and push the project directly. Specbook keeps this repository as the source of truth."
        actions={
          <Badge variant="secondary" className="font-mono">
            <GitBranch size={13} aria-hidden="true" /> {remote.branch}
          </Badge>
        }
      >
        <SettingsRow
          label="Clone URL"
          description="Served by the Specbook server."
        >
          <div className="flex min-w-0 gap-2">
            <code
              ref={urlRef}
              className={cn(
                "border-line bg-surface-soft text-meta text-ink block min-h-9 min-w-0 flex-1 rounded-md border px-3 font-mono",
                copyError === "url"
                  ? "py-2 leading-5 break-all"
                  : "truncate py-px leading-8"
              )}
              title={remote.cloneUrl}
            >
              {remote.cloneUrl}
            </code>
            <Button
              type="button"
              variant="outline"
              onClick={() => void copy(remote.cloneUrl, "url")}
              aria-live="polite"
            >
              {copied === "url" ? <Check size={14} /> : <Clipboard size={14} />}
              {copied === "url" ? "Copied" : "Copy"}
            </Button>
          </div>
          {copyError === "url" && (
            <p
              className="text-meta text-danger mt-2 flex items-start gap-1.5"
              role="alert"
            >
              <AlertCircle size={13} className="mt-0.5 shrink-0" /> Could not
              access the clipboard. The URL is selected; press Ctrl+C (or Cmd+C)
              to copy it.
            </p>
          )}
        </SettingsRow>

        <SettingsRow
          label="Access token"
          description={
            <>
              Git username{" "}
              <code className="text-ink-muted font-mono">specbook</code>, token
              as the password.
            </>
          }
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              {hasToken ? (
                <p className="text-control text-ink flex items-center gap-2">
                  <KeyRound
                    size={14}
                    className="text-ink-subtle"
                    aria-hidden="true"
                  />
                  <code className="text-meta font-mono">
                    {remote.token.prefix}...
                  </code>
                </p>
              ) : (
                <p className="text-control text-ink-muted">
                  No access token yet
                </p>
              )}
              {hasToken && (
                <p className="text-meta text-ink-subtle mt-0.5">
                  {remote.token.lastUsedAt ? (
                    <RelativeTime
                      value={remote.token.lastUsedAt}
                      prefix="Last used"
                    />
                  ) : (
                    "Never used"
                  )}
                </p>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant={hasToken ? "outline" : "default"}
                disabled={Boolean(busy)}
                onClick={(event) => {
                  if (hasToken) {
                    openConfirmation("rotate", event.currentTarget);
                  } else {
                    void issueToken();
                  }
                }}
              >
                {busy === "issue" ? (
                  <RefreshCw
                    size={14}
                    className="animate-spin motion-reduce:animate-none"
                  />
                ) : hasToken ? (
                  <RotateCw size={14} />
                ) : (
                  <KeyRound size={14} />
                )}
                {hasToken ? "Rotate" : "Create token"}
              </Button>
              {hasToken && (
                <Button
                  type="button"
                  variant="destructive-soft"
                  disabled={Boolean(busy)}
                  onClick={(event) =>
                    openConfirmation("revoke", event.currentTarget)
                  }
                >
                  <Trash2 size={14} /> Revoke
                </Button>
              )}
            </div>
          </div>
        </SettingsRow>

        {oneTimeToken && (
          <SettingsBlock className="bg-warning-soft/60">
            <div role="alert">
              <p className="text-control text-ink flex items-center gap-2 font-semibold">
                <KeyRound
                  size={14}
                  className="text-warning-icon"
                  aria-hidden="true"
                />{" "}
                Copy this token now
              </p>
              <p className="text-meta text-ink-muted mt-1">
                It is shown only once and cannot be recovered. Use username{" "}
                <code className="text-ink font-mono">specbook</code> when Git
                asks for credentials.
              </p>
            </div>
            <div className="mt-3 flex flex-wrap items-stretch gap-2">
              <code
                ref={tokenRef}
                className="border-warning/25 bg-surface text-meta text-ink flex min-h-9 min-w-0 flex-1 items-center rounded-md border px-3 py-2 font-mono break-all select-all"
              >
                {oneTimeToken}
              </code>
              <Button
                type="button"
                onClick={() => void copy(oneTimeToken, "token")}
                aria-live="polite"
              >
                {copied === "token" ? (
                  <Check size={14} />
                ) : (
                  <Clipboard size={14} />
                )}
                {copied === "token" ? "Copied" : "Copy token"}
              </Button>
            </div>
            {copyError === "token" && (
              <p className="text-meta text-danger mt-2 flex items-start gap-1.5">
                <AlertCircle size={13} className="mt-0.5 shrink-0" /> Could not
                access the clipboard. The token is selected; press Ctrl+C (or
                Cmd+C) to copy it.
              </p>
            )}
            <div className="mt-3 flex justify-end">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  onOneTimeTokenChange(null);
                  setCopyError(null);
                }}
              >
                I have saved it
              </Button>
            </div>
          </SettingsBlock>
        )}

        {(notice || error) && (
          <SettingsFooter
            feedback={
              error ? (
                <InlineFeedback
                  feedback={{
                    type: "error",
                    text: `Repository access failed: ${error}`,
                  }}
                />
              ) : (
                <InlineFeedback feedback={{ type: "success", text: notice }} />
              )
            }
          />
        )}
      </SettingsSection>

      <ConfirmDeleteDialog
        open={confirmation !== null}
        title={
          confirmation === "rotate"
            ? "Rotate access token?"
            : "Revoke access token?"
        }
        description={
          confirmation === "rotate" ? (
            <>
              A new token will be created and the current one stops working
              immediately. Update any Git clients that use it.
            </>
          ) : (
            <>
              The current token stops working immediately. Git clients using it
              can no longer clone or push until you create a new token.
            </>
          )
        }
        confirmLabel={
          confirmation === "rotate" ? "Rotate token" : "Revoke token"
        }
        busyLabel={confirmation === "rotate" ? "Rotating…" : "Revoking…"}
        busy={busy === "issue" || busy === "revoke"}
        error={confirmError}
        returnFocusRef={confirmTriggerRef}
        onCancel={() => {
          setConfirmation(null);
          setConfirmError("");
        }}
        onConfirm={() => void confirmTokenAction()}
      />
    </>
  );
}
