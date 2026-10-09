"use client";

import { useAuth } from "@/components/AuthProvider";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import { AlertCircle, ChevronRight, MessageSquareText, Plus, RefreshCw } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { PageContainer, PageHeader } from "@/components/PageHeader";
import { RelativeTime } from "@/components/RelativeTime";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage, isAbortError, listProjectChats } from "@/lib/api";
import { matchesInvalidation, onInvalidate } from "@/lib/invalidation";
import type { Chat } from "@/lib/types";

export default function ChatsHome({ params }: { params: Promise<{ projectId: string }> }) {
    const { canEdit } = useAuth();
    const { projectId } = use(params);
    const [chats, setChats] = useState<Chat[] | null>(null);
    const [error, setError] = useState("");
    const [refreshKey, setRefreshKey] = useState(0);
    const newChatHref = `/p/${projectId}/chats/new`;

    useEffect(() => {
        const controller = new AbortController();
        const load = () => {
            listProjectChats(projectId, controller.signal)
                .then(({ chats: result }) => {
                    setChats(result);
                    setError("");
                })
                .catch((loadError) => {
                    if (!isAbortError(loadError)) setError(errorMessage(loadError));
                });
        };
        load();
        const stop = onInvalidate((event) => {
            if (matchesInvalidation(event, "chats", projectId)) load();
        });
        return () => {
            controller.abort();
            stop();
        };
    }, [projectId, refreshKey]);

    const newChatButton = canEdit && (
        <Button asChild size="sm">
            <Link href={newChatHref}><Plus size={14} /> New chat</Link>
        </Button>
    );

    return (
        <div className="flex min-h-full flex-col bg-surface">
            <PageHeader
                title="Chats"
                width="chat"
            />
            {error && !chats ? (
                <div className="flex flex-1 items-center justify-center">
                    <EmptyState
                        role="alert"
                        tone="danger"
                        icon={AlertCircle}
                        title="Chats could not load"
                        description={error}
                        action={
                            <Button type="button" onClick={() => setRefreshKey((key) => key + 1)}>
                                <RefreshCw size={14} /> Try again
                            </Button>
                        }
                    />
                </div>
            ) : !chats ? (
                <PageContainer width="chat">
                    <div className="space-y-2" aria-busy="true" aria-label="Loading chats" role="status">
                        {[0, 1, 2].map((row) => <Skeleton key={row} className="h-[60px] w-full rounded-lg" />)}
                    </div>
                </PageContainer>
            ) : chats.length === 0 ? (
                <div className="flex flex-1 items-center justify-center">
                    <EmptyState
                        icon={MessageSquareText}
                        title="No chats yet"
                        description="Describe a behavior while the agent operates a live browser, and save the result as a Spec."
                        action={canEdit &&
                            <Button asChild>
                                <Link href={newChatHref}><MessageSquareText size={14} /> New chat</Link>
                            </Button>
                        }
                    />
                </div>
            ) : (
                <PageContainer width="chat">
                    <div className="mb-3 flex items-center justify-between gap-3">
                        <p className="tabular text-meta text-ink-muted">{chats.length} {chats.length === 1 ? "conversation" : "conversations"}</p>
                        {newChatButton}
                    </div>
                    <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line" aria-label="Chats">
                        {chats.map((chat) => (
                            <li key={chat.id}>
                                <Link
                                    href={`/p/${projectId}/chats/${chat.id}`}
                                    className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-soft focus-visible:bg-surface-soft focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
                                >
                                    <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-line bg-surface text-ink-muted" aria-hidden="true">
                                        <MessageSquareText size={14} />
                                    </span>
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate text-body font-medium text-ink">{chat.title}</span>
                                        {chat.source === "mcp" && <span className="block truncate text-meta text-ink-muted">via {chat.sourceClient || "External agent"}</span>}
                                        <RelativeTime value={chat.createdAt} prefix="Started" className="block text-meta text-ink-subtle" />
                                    </span>
                                    <ChevronRight size={15} className="shrink-0 text-ink-disabled transition-colors group-hover:text-ink-muted" aria-hidden="true" />
                                </Link>
                            </li>
                        ))}
                    </ul>
                </PageContainer>
            )}
        </div>
    );
}
