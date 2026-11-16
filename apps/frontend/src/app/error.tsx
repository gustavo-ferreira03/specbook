"use client";

import { AlertCircle, RefreshCw } from "lucide-react";
import Link from "next/link";

import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";

const ErrorPage = function ErrorPage({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <main className="bg-surface min-h-dvh px-4 py-12">
      <EmptyState
        icon={AlertCircle}
        tone="danger"
        role="alert"
        title="This page could not load"
        description="Try again. If the problem continues, check System status in instance settings."
        action={
          <Button onClick={retry}>
            <RefreshCw size={14} /> Try again
          </Button>
        }
        secondaryAction={
          <Button asChild variant="outline">
            <Link href="/settings?tab=system">System status</Link>
          </Button>
        }
      />
      {error.digest && (
        <p className="text-meta text-ink-subtle text-center">
          Error reference: {error.digest}
        </p>
      )}
    </main>
  );
};
export default ErrorPage;
