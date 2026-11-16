"use client";

import { ArrowLeft, ArrowRight } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { getProjectTree } from "@/lib/api";
import type { ProjectTree } from "@/lib/types";

export function SpecFolio({
  projectId,
  specId,
  featureId,
}: {
  projectId: string;
  specId: string;
  featureId: string;
}) {
  const [tree, setTree] = useState<ProjectTree | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    getProjectTree(projectId, controller.signal)
      .then(setTree)
      .catch(() => undefined);
    return () => controller.abort();
  }, [projectId]);

  if (!tree) {
    return null;
  }
  const chapter = tree.specs.filter((spec) => spec.featureId === featureId);
  const index = chapter.findIndex((spec) => spec.id === specId);
  if (index === -1) {
    return null;
  }
  const feature = tree.features.find((item) => item.id === featureId);
  const previous = chapter[index - 1];
  const next = chapter[index + 1];
  const href = (id: string) => `/p/${projectId}/specs/${id}`;
  return (
    <nav
      aria-label="Specs in this feature"
      className="border-line text-meta text-ink-muted mt-10 grid grid-cols-[1fr_auto_1fr] items-center gap-4 border-t pt-4"
    >
      {previous ? (
        <Link
          href={href(previous.id)}
          className="hover:text-ink flex min-w-0 items-center gap-1.5"
        >
          <ArrowLeft size={13} aria-hidden="true" className="shrink-0" />
          <span className="truncate">{previous.title}</span>
        </Link>
      ) : (
        <span />
      )}
      <span className="text-ink-subtle whitespace-nowrap">
        {feature ? `${feature.title} · ` : ""}
        <span className="tabular">
          {index + 1} of {chapter.length}
        </span>
      </span>
      {next ? (
        <Link
          href={href(next.id)}
          className="hover:text-ink flex min-w-0 items-center justify-end gap-1.5"
        >
          <span className="truncate">{next.title}</span>
          <ArrowRight size={13} aria-hidden="true" className="shrink-0" />
        </Link>
      ) : (
        <span />
      )}
    </nav>
  );
}
