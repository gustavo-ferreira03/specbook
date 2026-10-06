import { Check, AlertCircle } from "lucide-react";
import { SectionHeader } from "@/components/SectionHeader";
import { cn } from "@/lib/utils";

/**
 * Building blocks shared by the settings tabs: a section (SectionHeader + bordered panel),
 * label-left / control-right rows that stack on mobile, a footer for save actions, and a
 * one-line inline feedback message.
 */
export function SettingsSection({
    id,
    title,
    description,
    actions,
    tone = "default",
    className,
    children,
}: {
    id: string;
    title: React.ReactNode;
    description?: React.ReactNode;
    actions?: React.ReactNode;
    tone?: "default" | "danger";
    className?: string;
    children: React.ReactNode;
}) {
    return (
        <section aria-labelledby={id} className={cn("min-w-0", className)}>
            <SectionHeader id={id} title={title} description={description} actions={actions} className="mb-3" />
            <div className={cn("overflow-hidden rounded-xl border bg-surface", tone === "danger" ? "border-danger/25" : "border-line")}>{children}</div>
        </section>
    );
}

export function SettingsRow({
    label,
    htmlFor,
    description,
    children,
    align = "start",
    className,
}: {
    label: React.ReactNode;
    htmlFor?: string;
    description?: React.ReactNode;
    children: React.ReactNode;
    align?: "start" | "center";
    className?: string;
}) {
    const LabelTag = htmlFor ? "label" : "div";
    return (
        <div className={cn("grid gap-x-8 gap-y-2 border-b border-line px-4 py-4 last:border-b-0 sm:px-5 md:grid-cols-[minmax(0,13rem)_minmax(0,1fr)]", align === "center" && "md:items-center", className)}>
            <div className="min-w-0 md:pt-2">
                <LabelTag {...(htmlFor ? { htmlFor } : {})} className="block text-control font-medium text-ink">{label}</LabelTag>
                {description && <p className="mt-0.5 text-meta text-ink-subtle">{description}</p>}
            </div>
            <div className="min-w-0">{children}</div>
        </div>
    );
}

/** Row body without a label column (lists, editors, notices). */
export function SettingsBlock({ children, className }: { children: React.ReactNode; className?: string }) {
    return <div className={cn("border-b border-line px-4 py-4 last:border-b-0 sm:px-5", className)}>{children}</div>;
}

export function SettingsFooter({ children, feedback, className }: { children?: React.ReactNode; feedback?: React.ReactNode; className?: string }) {
    return (
        <div className={cn("flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-line bg-surface-soft px-4 py-3 sm:px-5", className)}>
            <div className="min-w-0 basis-full empty:hidden sm:basis-0 sm:flex-1 sm:empty:block">{feedback}</div>
            {children && <div className="ml-auto flex flex-wrap items-center justify-end gap-2">{children}</div>}
        </div>
    );
}

export interface InlineFeedbackValue {
    type: "success" | "error";
    text: string;
}

export function InlineFeedback({ feedback }: { feedback: InlineFeedbackValue | null | undefined }) {
    if (!feedback) return null;
    const success = feedback.type === "success";
    const Icon = success ? Check : AlertCircle;
    return (
        <p role={success ? "status" : "alert"} className={cn("flex items-start gap-1.5 text-control", success ? "text-success" : "text-danger")}>
            <Icon size={14} strokeWidth={2.25} aria-hidden="true" className="mt-0.5 shrink-0" />
            <span className="min-w-0 break-words">{feedback.text}</span>
        </p>
    );
}
