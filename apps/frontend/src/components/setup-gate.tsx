"use client";

import { AlertCircle, RefreshCw } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { useAuth } from "@/components/auth-provider";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, errorMessage, isAbortError } from "@/lib/api";
import type { SetupStatus } from "@/lib/types";

export const SetupGate = function SetupGate({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, loading, isAdmin } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const [allowed, setAllowed] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const setupRoute =
    pathname === "/setup" || pathname === "/login" || pathname === "/join";

  useEffect(() => {
    if (setupRoute || loading) {
      return;
    }
    const controller = new AbortController();
    // oxlint-disable-next-line react/set-state-in-effect -- Reset the previous request or selection when its external key changes before loading fresh state.
    setError("");
    (async () => {
      try {
        const resolvedValue = await api<SetupStatus>("/setup/status", {
          signal: controller.signal,
        });
        const status = resolvedValue;
        if (
          status.needsAdmin ||
          (isAdmin && status.needsProject && pathname !== "/settings")
        ) {
          setAllowed(false);
          router.replace("/setup");
        } else if (user) {
          setAllowed(true);
        } else {
          setAllowed(false);
          router.replace(
            `/login?next=${encodeURIComponent(`${pathname}${window.location.search}${window.location.hash}`)}`
          );
        }
      } catch (error_) {
        if (!isAbortError(error_)) {
          setError(errorMessage(error_));
        }
      }
    })();
    return () => controller.abort();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- This dependency intentionally triggers a retry, navigation reset, or DOM measurement without being read by the effect.
  }, [attempt, pathname, router, setupRoute, loading, user, isAdmin]);

  if (setupRoute || (allowed && user)) {
    return children;
  }
  if (error) {
    return (
      <main className="bg-surface min-h-dvh">
        <EmptyState
          icon={AlertCircle}
          tone="danger"
          role="alert"
          title="Specbook could not connect"
          description={error}
          action={
            <Button onClick={() => setAttempt((value) => value + 1)}>
              <RefreshCw size={14} /> Try again
            </Button>
          }
        />
      </main>
    );
  }
  return (
    /* oxlint-disable jsx-a11y/prefer-tag-over-role -- Alert forwards live-region semantics to its shared native wrapper; preserve the component structure. */
    <main
      className="bg-surface min-h-dvh px-4 py-8"
      role="status"
      aria-label="Loading Specbook"
      aria-busy="true"
    >
      <div className="max-w-reading mx-auto space-y-5">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-40 w-full" />
      </div>
    </main>
    /* oxlint-enable jsx-a11y/prefer-tag-over-role */
  );
};
