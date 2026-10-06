"use client";

import type { RefObject } from "react";
import { AlertTriangle, X } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export function ConfirmDeleteDialog({
    open,
    title,
    description,
    confirmLabel,
    busyLabel = "Deleting…",
    busy,
    error,
    returnFocusRef,
    onCancel,
    onConfirm,
}: {
    open: boolean;
    title: string;
    description: React.ReactNode;
    confirmLabel: string;
    busyLabel?: string;
    busy: boolean;
    error: string;
    returnFocusRef?: RefObject<HTMLElement | null>;
    onCancel: () => void;
    onConfirm: () => void;
}) {
    return (
        <AlertDialog open={open} onOpenChange={(nextOpen) => {
            if (!nextOpen && !busy) onCancel();
        }}>
            <AlertDialogContent
                onCloseAutoFocus={(event) => {
                    const trigger = returnFocusRef?.current;
                    if (!trigger?.isConnected) return;
                    event.preventDefault();
                    trigger.focus();
                }}
                onEscapeKeyDown={(event) => {
                    if (busy) event.preventDefault();
                }}
            >
                <div className="flex items-start gap-3.5 px-5 pt-5">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-danger-soft text-danger">
                        <AlertTriangle size={16} />
                    </span>
                    <div className="min-w-0 flex-1">
                        <AlertDialogTitle>{title}</AlertDialogTitle>
                        <AlertDialogDescription className="mt-1.5">{description}</AlertDialogDescription>
                    </div>
                    <AlertDialogCancel
                        disabled={busy}
                        className="size-8 border-0 bg-transparent p-0 shadow-none text-ink-subtle hover:bg-surface-hover hover:text-ink"
                        aria-label="Close confirmation"
                    >
                        <X size={15} />
                    </AlertDialogCancel>
                </div>
                {error && <Alert variant="danger" className="mx-5 mt-4 w-auto" role="alert">{error}</Alert>}
                <AlertDialogFooter className="px-5 pt-5 pb-5">
                    <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                        disabled={busy}
                        onClick={(event) => {
                            event.preventDefault();
                            onConfirm();
                        }}
                    >
                        {busy ? busyLabel : confirmLabel}
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
