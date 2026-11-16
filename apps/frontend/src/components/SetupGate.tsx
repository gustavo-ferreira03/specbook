"use client";

import { AlertCircle, RefreshCw } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { useAuth } from "@/components/AuthProvider";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, errorMessage, isAbortError } from "@/lib/api";
import type { SetupStatus } from "@/lib/types";

export function SetupGate({ children }: { children: React.ReactNode }) {
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
    setError("");
    void api<SetupStatus>("/setup/status", { signal: controller.signal })
      .then((status) => {
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
      })
      .catch((reason) => {
        if (!isAbortError(reason)) {
          setError(errorMessage(reason));
        }
      });
    return () => controller.abort();
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
  );
}
