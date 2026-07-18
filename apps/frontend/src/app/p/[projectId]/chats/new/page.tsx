"use client";

import Link from "next/link";
import { Suspense, use, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertCircle, RefreshCw } from "lucide-react";
import { LogoMark } from "@/components/LogoMark";
import { PageHeader } from "@/components/PageHeader";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

function NewChatContent({ projectId }: { projectId: string }) {
    const router = useRouter();
    const searchParams = useSearchParams();
    const specId = searchParams.get("specId");
    const [error, setError] = useState("");
    const [attempt, setAttempt] = useState(0);
    const requestRef = useRef<{ key: string; promise: Promise<{ chat: { id: string } }> } | null>(null);

    useEffect(() => {
        const key = `${projectId}:${attempt}`;
        if (requestRef.current?.key !== key) {
            requestRef.current = {
                key,
                promise: api<{ chat: { id: string } }>(`/projects/${projectId}/chats`, { method: "POST" }),
            };
        }
        let active = true;
        setError("");
        requestRef.current.promise
            .then((result) => {
                if (!active) return;
                const query = specId ? `?specId=${encodeURIComponent(specId)}` : "";
                router.replace(`/p/${projectId}/chats/${result.chat.id}${query}`);
            })
            .catch((createError) => {
                if (active) setError(createError instanceof Error ? createError.message : String(createError));
            });
        return () => {
            active = false;
        };
    }, [attempt, projectId, router, specId]);

    if (error) {
        return (
            <div className="flex min-h-full flex-col bg-surface">
                <PageHeader title="New chat" eyebrow="Chats" />
                <div className="flex flex-1 items-center justify-center px-5 py-10">
                    <Alert variant="destructive" className="w-full max-w-sm bg-transparent p-0 text-center" role="alert">
                        <span className="mx-auto flex size-9 items-center justify-center rounded-lg bg-danger-soft text-danger"><AlertCircle size={18} /></span>
                        <h2 className="mt-4 text-sm font-bold text-ink">Chat could not start</h2>
                        <AlertDescription className="mt-2 text-xs leading-5">{error}</AlertDescription>
                        <div className="mt-5 flex justify-center gap-2">
                            <Button type="button" onClick={() => setAttempt((value) => value + 1)}><RefreshCw size={14} /> Try again</Button>
                            <Button asChild variant="outline"><Link href={`/p/${projectId}`}>Return to project</Link></Button>
                        </div>
                    </Alert>
                </div>
            </div>
        );
    }

    return (
        <div className="flex min-h-full flex-col bg-surface" role="status">
            <PageHeader title="New chat" eyebrow="Chats" />
            <div className="flex flex-1 items-center justify-center px-5 py-10 text-center">
                <div><LogoMark className="status-pulse mx-auto size-9" /><h2 className="mt-4 text-[0.8125rem] font-bold">Starting chat</h2><p className="mt-1 text-[0.65625rem] text-ink-faint">Preparing the agent workspace</p></div>
            </div>
        </div>
    );
}

export default function NewChat({ params }: { params: Promise<{ projectId: string }> }) {
    const { projectId } = use(params);
    return <Suspense fallback={<span className="sr-only" role="status">Starting chat</span>}><NewChatContent projectId={projectId} /></Suspense>;
}
