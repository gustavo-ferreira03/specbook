"use client";

import { ArrowRight, KeyRound } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { useAuth } from "@/components/auth-provider";
import { AuthField, AuthShell } from "@/components/auth-shell";
import { InlineFeedback } from "@/components/settings-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api, errorMessage, safeReturnPath } from "@/lib/api";

const LoginContent = function LoginContent() {
  const router = useRouter();
  const search = useSearchParams();
  const { refresh } = useAuth();
  const [options, setOptions] = useState<{
    passwordLoginEnabled: boolean;
    oidcEnabled: boolean;
  } | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(
    search.get("error")
      ? "Single sign-on could not complete. Try again or contact your administrator."
      : ""
  );
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const resolvedValue = await api<{
          needsAdmin: boolean;
          passwordLoginEnabled: boolean;
          oidcEnabled: boolean;
        }>("/auth/options");
        const result = resolvedValue;
        if (!active) {
          return;
        }
        if (result.needsAdmin) {
          router.replace("/setup");
          return;
        }
        setOptions(result);
      } catch (error_) {
        if (active) {
          setError(errorMessage(error_));
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [router]);
  const login = async function login(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: email.trim(), password }),
      });
      setPassword("");
      await refresh();
      router.replace(safeReturnPath(search.get("next")));
    } catch (error_) {
      setError(errorMessage(error_));
      setBusy(false);
    }
  };
  const singleSignOn = async function singleSignOn() {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ url: string }>("/auth/oidc/start", {
        method: "POST",
        body: JSON.stringify({}),
      });
      window.location.assign(result.url);
    } catch (error_) {
      setError(errorMessage(error_));
      setBusy(false);
    }
  };
  return (
    <AuthShell
      title="Sign in"
      footer="Need an account? Ask your administrator for an invitation link."
    >
      {!options && !error ? (
        <Skeleton className="h-44 w-full" />
      ) : (
        <div className="space-y-5">
          {options?.oidcEnabled && (
            <Button
              variant="outline"
              className="h-10 w-full"
              onClick={() => singleSignOn()}
              disabled={busy}
            >
              <KeyRound size={14} /> Continue with single sign-on
            </Button>
          )}
          {options?.oidcEnabled && options.passwordLoginEnabled && (
            <div className="text-meta text-ink-subtle flex items-center gap-3">
              <span className="bg-line h-px flex-1" />
              or
              <span className="bg-line h-px flex-1" />
            </div>
          )}
          {options?.passwordLoginEnabled && (
            <form onSubmit={login} className="space-y-4">
              <AuthField id="login-email" label="Email">
                <Input
                  id="login-email"
                  type="email"
                  autoComplete="username"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  disabled={busy}
                  className="h-10"
                />
              </AuthField>
              <AuthField id="login-password" label="Password">
                <Input
                  id="login-password"
                  type="password"
                  autoComplete="current-password"
                  required
                  maxLength={128}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  disabled={busy}
                  className="h-10"
                />
              </AuthField>
              <InlineFeedback
                feedback={error ? { type: "error", text: error } : null}
              />
              <Button type="submit" className="h-10 w-full" disabled={busy}>
                {busy ? "Signing in…" : "Sign in"}
                <ArrowRight size={14} />
              </Button>
            </form>
          )}
          {!options?.passwordLoginEnabled && error && (
            <InlineFeedback feedback={{ type: "error", text: error }} />
          )}
          {!options && error && (
            <Button
              variant="outline"
              className="h-10 w-full"
              onClick={() => window.location.reload()}
            >
              Try again
            </Button>
          )}
        </div>
      )}
    </AuthShell>
  );
};

const LoginPage = function LoginPage() {
  return (
    <Suspense fallback={<output className="sr-only">Loading sign in</output>}>
      <LoginContent />
    </Suspense>
  );
};
export default LoginPage;
