"use client";

import Link from "next/link";
import { use } from "react";
import { MessageSquareText } from "lucide-react";
import { LogoMark } from "@/components/LogoMark";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";

export default function ChatsHome({ params }: { params: Promise<{ projectId: string }> }) {
    const { projectId } = use(params);
    return (
        <div className="flex min-h-full flex-col bg-surface">
            <PageHeader title="Chats" eyebrow="Project" />
            <div className="flex flex-1 items-center justify-center px-5 py-10">
                <div className="max-w-[420px] text-center">
                    <LogoMark className="mx-auto size-9" />
                    <h2 className="mt-4 text-sm font-bold">No chat selected</h2>
                    <p className="mt-2 text-xs leading-5 text-ink-soft">
                        Describe a behavior in a chat while the agent operates a live browser, or pick up an
                        existing one from the sidebar.
                    </p>
                    <Button asChild className="mt-5">
                        <Link href={`/p/${projectId}/chats/new`}>
                            <MessageSquareText size={13} /> Start chat
                        </Link>
                    </Button>
                </div>
            </div>
        </div>
    );
}
