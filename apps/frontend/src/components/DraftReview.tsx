"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { BookOpenCheck, Check, Compass, PencilLine, Trash2, X } from "lucide-react";
import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { ContextReadout } from "@/components/ContextReadout";
import { ProjectContextEditor } from "@/components/ProjectContextEditor";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { confirmProjectContext, discardProjectContext } from "@/lib/api";
import type { ProjectContextRevision } from "@/lib/types";

export function DraftReview({
    revision,
    chatHref,
    onSaved,
    onConfirmed,
    onDiscarded,
}: {
    revision: ProjectContextRevision;
    chatHref: string | null;
    onSaved: (revision: ProjectContextRevision) => void;
    onConfirmed: (revision: ProjectContextRevision) => void;
    onDiscarded: (revision: ProjectContextRevision) => void;
}) {
    const [editing, setEditing] = useState(false);
    const [confirming, setConfirming] = useState(false);
    const [discarding, setDiscarding] = useState(false);
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [discardOpen, setDiscardOpen] = useState(false);
    const [error, setError] = useState("");
    const [discardError, setDiscardError] = useState("");
    const confirmTriggerRef = useRef<HTMLButtonElement>(null);
    const discardTriggerRef = useRef<HTMLButtonElement>(null);

    const { context } = revision;
    const confirmable = context.summary.trim().length > 0 && (context.areas.length > 0 || context.unknowns.length > 0);

    async function confirmDraft() {
        setError("");
        setConfirming(true);
        try {
            const { revision: confirmed } = await confirmProjectContext(revision.id);
            setConfirmOpen(false);
            onConfirmed(confirmed);
        } catch (err) {
            setConfirmOpen(false);
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setConfirming(false);
        }
    }

    async function discardDraft() {
        setDiscardError("");
        setDiscarding(true);
        try {
            const { revision: discarded } = await discardProjectContext(revision.id);
            setDiscardOpen(false);
            onDiscarded(discarded);
        } catch (err) {
            setDiscardError(err instanceof Error ? err.message : String(err));
        } finally {
            setDiscarding(false);
        }
    }

    if (editing) {
        return (
            <ProjectContextEditor
                revision={revision}
                onSaved={(updated) => {
                    onSaved(updated);
                    setEditing(false);
                }}
                onCancel={() => setEditing(false)}
            />
        );
    }

    return (
        <div className="space-y-4">
            <ContextReadout context={context} />

            {error && (
                <Alert variant="destructive" className="text-xs" role="alert">
                    <AlertDescription>{error}</AlertDescription>
                </Alert>
            )}

            {!confirmable && (
                <p className="text-[0.625rem] leading-4 text-ink-faint">
                    Confirming needs a summary and at least one area or unknown.
                </p>
            )}

            <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
                <Button type="button" variant="outline" onClick={() => setEditing(true)}>
                    <PencilLine size={14} /> Edit
                </Button>
                {chatHref && (
                    <Button asChild variant="outline">
                        <Link href={chatHref}><Compass size={14} /> Continue exploring</Link>
                    </Button>
                )}
                <Button
                    ref={confirmTriggerRef}
                    type="button"
                    onClick={() => setConfirmOpen(true)}
                    disabled={confirming || !confirmable}
                    title={confirmable ? undefined : "Confirmation needs a summary and at least one area or unknown"}
                >
                    <Check size={14} /> {confirming ? "Confirming..." : "Confirm context"}
                </Button>
                <Button
                    ref={discardTriggerRef}
                    type="button"
                    variant="ghost"
                    onClick={() => setDiscardOpen(true)}
                    disabled={discarding}
                    className="text-ink-soft"
                >
                    <Trash2 size={14} /> {discarding ? "Discarding..." : "Discard draft"}
                </Button>
            </div>

            <AlertDialog open={confirmOpen} onOpenChange={(open) => !confirming && setConfirmOpen(open)}>
                <AlertDialogContent
                    onCloseAutoFocus={(event) => {
                        const trigger = confirmTriggerRef.current;
                        if (!trigger?.isConnected) return;
                        event.preventDefault();
                        trigger.focus();
                    }}
                    onEscapeKeyDown={(event) => {
                        if (confirming) event.preventDefault();
                    }}
                >
                    <div className="flex items-start gap-3 border-b border-line px-4 py-4">
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-success-soft text-success">
                            <BookOpenCheck size={16} />
                        </span>
                        <div className="min-w-0 flex-1">
                            <AlertDialogTitle>Confirm this project context?</AlertDialogTitle>
                            <AlertDialogDescription className="mt-1.5">
                                Every future chat in this project receives it as reviewed background knowledge. Update it later with a new discovery.
                            </AlertDialogDescription>
                        </div>
                        <AlertDialogCancel
                            disabled={confirming}
                            className="size-8 border-0 bg-transparent p-0 text-ink-faint hover:bg-surface-hover hover:text-ink"
                            aria-label="Close confirmation"
                        >
                            <X size={15} />
                        </AlertDialogCancel>
                    </div>
                    <div className="flex justify-end gap-2 px-4 py-3">
                        <AlertDialogCancel disabled={confirming}>Keep editing</AlertDialogCancel>
                        <AlertDialogAction
                            disabled={confirming}
                            className="bg-primary text-primary-foreground hover:bg-primary-hover"
                            onClick={(event) => {
                                event.preventDefault();
                                void confirmDraft();
                            }}
                        >
                            {confirming ? "Confirming..." : "Confirm context"}
                        </AlertDialogAction>
                    </div>
                </AlertDialogContent>
            </AlertDialog>

            <ConfirmDeleteDialog
                open={discardOpen}
                title="Discard this draft?"
                description="The drafted context and its edits are discarded. Any previously confirmed context stays active."
                confirmLabel="Discard draft"
                busyLabel="Discarding..."
                busy={discarding}
                error={discardError}
                returnFocusRef={discardTriggerRef}
                onCancel={() => {
                    setDiscardOpen(false);
                    setDiscardError("");
                }}
                onConfirm={() => void discardDraft()}
            />
        </div>
    );
}
