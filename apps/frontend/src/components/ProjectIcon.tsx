"use client";

import { useState } from "react";
import { API_URL } from "@/lib/api";
import { cn } from "@/lib/utils";

export function ProjectIcon({ projectId, name, className }: { projectId: string; name: string; className?: string }) {
    const [state, setState] = useState<"loading" | "loaded" | "missing">("loading");
    return (
        <span className={cn("relative flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-[5px]", state !== "loaded" && "border border-current/25 text-label uppercase", className)} aria-hidden="true">
            {state !== "loaded" && (name.trim().charAt(0) || "P")}
            {state !== "missing" && (
                <img
                    src={`${API_URL}/projects/${encodeURIComponent(projectId)}/favicon`}
                    alt=""
                    draggable={false}
                    onLoad={() => setState("loaded")}
                    onError={() => setState("missing")}
                    className={cn("size-full object-contain", state === "loaded" ? "relative" : "absolute opacity-0")}
                />
            )}
        </span>
    );
}
