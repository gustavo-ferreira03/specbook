import Link from "next/link";
import { ArrowRight, BookOpenCheck, MessageSquareText } from "lucide-react";
import { LogoMark } from "@/components/LogoMark";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

export default async function ProjectHome({ params }: { params: Promise<{ projectId: string }> }) {
    const { projectId } = await params;
    return (
        <div className="flex min-h-full flex-col bg-surface">
            <PageHeader title="Project overview" eyebrow="Project" />
            <div className="flex flex-1 items-center justify-center px-5 py-10">
                <div className="w-full max-w-[560px]">
                    <LogoMark className="size-10" />
                    <h2 className="mt-5 text-xl font-bold tracking-[-0.025em]">Describe a behavior worth keeping</h2>
                    <p className="mt-3 max-w-[62ch] text-xs leading-5 text-ink-soft">
                        Start a conversation. The agent will inspect the live application, ask for missing rules, and save the verified behavior as a Spec.
                    </p>
                    <Button asChild className="mt-6">
                        <Link href={`/p/${projectId}/conversations/new`}>
                            <MessageSquareText size={14} /> Start conversation <ArrowRight size={13} />
                        </Link>
                    </Button>
                    <div className="mt-8">
                        <Separator className="mb-4" />
                        <div className="flex items-center gap-3 py-2 text-[0.6875rem] text-ink-soft"><MessageSquareText size={14} className="text-ink-faint" /> Describe or explore a real user flow</div>
                        <div className="flex items-center gap-3 py-2 text-[0.6875rem] text-ink-soft"><BookOpenCheck size={14} className="text-ink-faint" /> Keep the readable behavior, verification, and evidence together</div>
                    </div>
                </div>
            </div>
        </div>
    );
}
