"use client";

import Link from "next/link";
import { Suspense, use, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertCircle, RefreshCw } from "lucide-react";
import { LogoMark } from "@/components/LogoMark";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { api, apiPath, errorMessage } from "@/lib/api";

function NewChatContent({ projectId }: { projectId: string }) {
    const router = useRouter();
    const searchParams = useSearchParams();
    const specId = searchParams.get("specId");
    const intent = searchParams.get("intent");
    const [error, setError] = useState("");
    const [attempt, setAttempt] = useState(0);
    const requestRef = useRef<{ key: string; promise: Promise<{ chat: { id: string } }> } | null>(null);

    useEffect(() => {
        const key = `${projectId}:${attempt}`;
        if (requestRef.current?.key !== key) {
            requestRef.current = {
                key,
                promise: api<{ chat: { id: string } }>(apiPath`/projects/${projectId}/chats`, { method: "POST" }),
            };
        }
        let active = true;
        setError("");
        requestRef.current.promise
            .then((result) => {
                if (!active) return;
                const query = specId ? `?specId=${encodeURIComponent(specId)}${intent === "repair" ? "&intent=repair" : ""}` : "";
                router.replace(`/p/${projectId}/chats/${result.chat.id}${query}`);
            })
            .catch((createError) => {
                if (active) setError(errorMessage(createError));
            });
        return () => {
            active = false;
        };
    }, [attempt, intent, projectId, router, specId]);

    const crumbs = [{ label: "Chats", href: `/p/${projectId}/chats` }];

    if (error) {
        return (
            <div className="flex min-h-full flex-col bg-surface">
                <PageHeader title="New chat" breadcrumbs={crumbs} width="chat" />
                <div className="flex flex-1 items-center justify-center">
                    <EmptyState
                        role="alert"
                        tone="danger"
                        icon={AlertCircle}
                        title="Chat could not start"
                        description={error}
                        action={<Button type="button" onClick={() => setAttempt((value) => value + 1)}><RefreshCw size={14} /> Try again</Button>}
                        secondaryAction={<Button asChild variant="outline"><Link href={`/p/${projectId}`}>Return to project</Link></Button>}
                    />
                </div>
            </div>
        );
    }

    return (
        <div className="flex min-h-full flex-col bg-surface" role="status">
            <PageHeader title="New chat" breadcrumbs={crumbs} width="chat" />
            <div className="flex flex-1 flex-col items-center justify-center px-5 py-12 text-center">
                <span className="flex size-12 items-center justify-center rounded-full border border-line bg-surface" aria-hidden="true">
                    <LogoMark className="status-pulse size-6 dark:invert" />
                </span>
                <p className="mt-4 text-section text-ink">Starting chat</p>
                <p className="mt-1 text-control text-ink-muted">Preparing the agent workspace</p>
            </div>
        </div>
    );
}

export default function NewChat({ params }: { params: Promise<{ projectId: string }> }) {
    const { projectId } = use(params);
    return <Suspense fallback={<span className="sr-only" role="status">Starting chat</span>}><NewChatContent projectId={projectId} /></Suspense>;
}
