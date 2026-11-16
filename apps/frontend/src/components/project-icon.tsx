"use client";

import { useState } from "react";

import { API_URL } from "@/lib/api";
import { cn } from "@/lib/utils";

export const ProjectIcon = function ProjectIcon({
  projectId,
  name,
  className,
}: {
  projectId: string;
  name: string;
  className?: string;
}) {
  const [state, setState] = useState<"loading" | "loaded" | "missing">(
    "loading"
  );
  return (
    <span
      className={cn(
        "relative flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-[5px]",
        state !== "loaded" && "text-label border border-current/25 uppercase",
        className
      )}
      aria-hidden="true"
    >
      {state !== "loaded" && (name.trim().charAt(0) || "P")}
      {state !== "missing" && (
        /* oxlint-disable next/no-img-element -- Evidence URLs and CSS-sized SVG icons must load directly without an image optimization proxy. */
        <img
          src={`${API_URL}/projects/${encodeURIComponent(projectId)}/favicon`}
          alt=""
          draggable={false}
          onLoad={() => setState("loaded")}
          onError={() => setState("missing")}
          className={cn(
            "size-full object-contain",
            state === "loaded" ? "relative" : "absolute opacity-0"
          )}
        />
        /* oxlint-enable next/no-img-element */
      )}
    </span>
  );
};
