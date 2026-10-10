"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Target, X } from "lucide-react";
import { Brand } from "@/components/LogoMark";
import { SpecGrid } from "@/components/SpecGrid";
import { Button } from "@/components/ui/button";

export default function NotFound() {
    const path = usePathname() || "/";
    return (
        <main className="relative isolate flex min-h-dvh flex-col overflow-hidden bg-surface px-6 py-6 sm:px-10">
            <SpecGrid className="-z-10" />
            <Link href="/" className="w-fit rounded-sm"><Brand /></Link>
            <div className="mx-auto flex w-full max-w-[460px] flex-1 flex-col justify-center py-12">
                <p className="truncate font-mono text-meta text-ink-muted">{path}</p>
                <h1 className="mt-2 text-title text-ink">Page not found</h1>
                <ol className="mt-8">
                    <li className="flex items-start gap-3 text-body text-ink">
                        <span className="tabular flex size-6 shrink-0 items-center justify-center rounded-md border border-line-strong text-meta font-semibold">1</span>
                        <span className="min-w-0 flex-1 pt-0.5 [overflow-wrap:anywhere]">Open <span className="font-mono text-control">{path}</span></span>
                        <X size={15} strokeWidth={2.5} aria-label="Failed" className="mt-1 shrink-0 text-danger" />
                    </li>
                </ol>
                <div className="mt-6 rounded-xl border border-line-strong px-4 py-3.5">
                    <p className="flex items-center gap-1.5 text-control font-semibold text-ink"><Target size={14} aria-hidden="true" className="text-ink-muted" /> Expected result</p>
                    <p className="mt-1.5 text-body text-ink">A Specbook page opens.</p>
                    <p className="mt-3 border-t border-line pt-3 text-body text-ink-muted">Nothing exists at this address. It may have been renamed or deleted.</p>
                </div>
                <p className="tabular mt-5 flex items-center gap-1.5 text-meta font-medium text-danger"><X size={13} strokeWidth={2.5} aria-hidden="true" /> Failed · 404</p>
                <Button asChild className="mt-8 h-10 w-fit"><Link href="/">Return to projects</Link></Button>
            </div>
        </main>
    );
}
