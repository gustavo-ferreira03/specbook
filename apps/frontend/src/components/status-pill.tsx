"use client";

import { useState } from "react";

import { statusMeta } from "@/lib/status";
import { cn } from "@/lib/utils";

const FINAL = new Set(["passed", "failed", "error", "invalid"]);

export const StatusPill = function StatusPill({
  status,
  kind = "spec",
  size = "default",
  className,
}: {
  status: string;
  kind?: "spec" | "run";
  size?: "default" | "sm";
  className?: string;
}) {
  const meta = statusMeta(status);
  const Icon = meta.icon;
  const [transition, setTransition] = useState({ status, settled: false });
  const settled =
    transition.status === status
      ? transition.settled
      : transition.status === "running" && FINAL.has(status);
  if (transition.status !== status) {
    setTransition({ status, settled });
  }
  return (
    <span
      className={cn(
        "text-meta inline-flex w-fit shrink-0 items-center gap-1.5 font-medium whitespace-nowrap",
        size === "sm" ? "h-5" : "h-6",
        status === "flaky" &&
          "border-warning-icon rounded-full border-(length:--stroke) px-2 shadow-[2px_2px_0_var(--color-warning-icon)]",
        meta.text,
        className
      )}
      title={meta.description || undefined}
    >
      <Icon
        key={settled ? `${status}-settled` : status}
        size={size === "sm" ? 12 : 13}
        strokeWidth={2.25}
        aria-hidden="true"
        className={cn(
          meta.iconColor,
          status === "running" && "animate-spin motion-reduce:animate-none",
          settled && "status-stamp"
        )}
      />
      {kind === "run" ? meta.runLabel : meta.label}
    </span>
  );
};
