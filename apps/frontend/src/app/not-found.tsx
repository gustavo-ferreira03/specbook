"use client";

import { Target, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { Brand } from "@/components/LogoMark";
import { SpecGrid } from "@/components/SpecGrid";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  const path = usePathname() || "/";
  return (
    <main className="bg-surface relative isolate flex min-h-dvh flex-col overflow-hidden px-6 py-6 sm:px-10">
      <SpecGrid className="-z-10" />
      <Link href="/" className="w-fit rounded-sm">
        <Brand />
      </Link>
      <div className="mx-auto flex w-full max-w-[460px] flex-1 flex-col justify-center py-12">
        <p className="text-meta text-ink-muted truncate font-mono">{path}</p>
        <h1 className="text-title text-ink mt-2">Page not found</h1>
        <ol className="mt-8">
          <li className="text-body text-ink flex items-start gap-3">
            <span className="tabular border-line-strong text-meta flex size-6 shrink-0 items-center justify-center rounded-md border font-semibold">
              1
            </span>
            <span className="min-w-0 flex-1 pt-0.5 [overflow-wrap:anywhere]">
              Open <span className="text-control font-mono">{path}</span>
            </span>
            <X
              size={15}
              strokeWidth={2.5}
              aria-label="Failed"
              className="text-danger mt-1 shrink-0"
            />
          </li>
        </ol>
        <div className="border-line-strong mt-6 rounded-xl border px-4 py-3.5">
          <p className="text-control text-ink flex items-center gap-1.5 font-semibold">
            <Target size={14} aria-hidden="true" className="text-ink-muted" />{" "}
            Expected result
          </p>
          <p className="text-body text-ink mt-1.5">A Specbook page opens.</p>
          <p className="border-line text-body text-ink-muted mt-3 border-t pt-3">
            Nothing exists at this address. It may have been renamed or deleted.
          </p>
        </div>
        <p className="tabular text-meta text-danger mt-5 flex items-center gap-1.5 font-medium">
          <X size={13} strokeWidth={2.5} aria-hidden="true" /> Failed · 404
        </p>
        <Button asChild className="mt-8 h-10 w-fit">
          <Link href="/">Return to projects</Link>
        </Button>
      </div>
    </main>
  );
}
