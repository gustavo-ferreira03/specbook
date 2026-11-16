"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { useAuth } from "@/components/auth-provider";
import { AuthField, AuthShell } from "@/components/auth-shell";
import { InlineFeedback } from "@/components/settings-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

const JoinPage = function JoinPage() {
  const router = useRouter();
  const { refresh } = useAuth();
  const token = useRef<string | null>(null);
  const [invitation, setInvitation] = useState<{
    email: string;
    role: string;
    expiresAt: string;
  } | null>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (token.current === null) {
      token.current =
        new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "";
      window.history.replaceState(window.history.state, "", "/join");
    }
    if (!token.current) {
      setError(
        "This invitation link is incomplete. Ask your administrator for a new link."
      );
      return;
    }
    let active = true;
    (async () => {
      try {
        const resolvedValue = await api<{
          email: string;
          role: string;
          expiresAt: string;
        }>("/auth/invitations/inspect", {
          method: "POST",
          body: JSON.stringify({ token: token.current }),
        });
        const result = resolvedValue;
        if (active) {
          setInvitation(result);
        }
      } catch (error_) {
        if (active) {
          setError(errorMessage(error_));
        }
      }
    })();
    return () => {
      active = false;
    };
  }, []);
  const accept = async function accept(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/auth/invitations/accept", {
        method: "POST",
        body: JSON.stringify({
          token: token.current,
          name: name.trim(),
          password,
        }),
      });
      setPassword("");
      token.current = "";
      await refresh();
      router.replace("/");
    } catch (error_) {
      setError(errorMessage(error_));
      setBusy(false);
    }
  };
  return (
    <AuthShell
      title="Join Specbook"
      description="Create your account to accept the invitation."
      footer={
        <Link
          href="/login"
          className="text-ink font-medium underline-offset-4 hover:underline"
        >
          Already have an account? Sign in
        </Link>
      }
    >
      {(() => {
        if (invitation) {
          return (
            <form onSubmit={accept} className="space-y-4">
              <div className="border-line rounded-lg border px-3.5 py-3">
                <p className="text-body text-ink">
                  Invited as{" "}
                  <strong className="font-medium">{invitation.email}</strong>{" "}
                  with <span className="font-medium">{invitation.role}</span>{" "}
                  access.
                </p>
                <p className="text-meta text-ink-muted mt-0.5">
                  Expires {formatDateTime(invitation.expiresAt)}
                </p>
              </div>
              <AuthField id="join-name" label="Name">
                <Input
                  id="join-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  autoComplete="name"
                  required
                  disabled={busy}
                  className="h-10"
                />
              </AuthField>
              <AuthField
                id="join-password"
                label="Password"
                hint="Use at least 12 characters."
              >
                <Input
                  id="join-password"
                  aria-describedby="join-password-hint"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  maxLength={128}
                  required
                  disabled={busy}
                  className="h-10"
                />
              </AuthField>
              <InlineFeedback
                feedback={error ? { type: "error", text: error } : null}
              />
              <Button type="submit" className="h-10 w-full" disabled={busy}>
                {busy ? "Creating account…" : "Accept invitation"}
              </Button>
            </form>
          );
        }
        if (error) {
          return <InlineFeedback feedback={{ type: "error", text: error }} />;
        }
        return <Skeleton className="h-44 w-full" />;
      })()}
    </AuthShell>
  );
};
export default JoinPage;
