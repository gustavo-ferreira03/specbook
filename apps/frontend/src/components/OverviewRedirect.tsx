"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

export function OverviewRedirect({ projectId }: { projectId: string }) {
    const router = useRouter();
    useEffect(() => { router.replace(`/p/${projectId}/overview${window.location.hash}`); }, [projectId, router]);
    return <p role="status" className="p-6 text-body text-ink-muted">Opening Overview…</p>;
}
