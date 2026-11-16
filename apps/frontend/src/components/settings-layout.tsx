import { Check, AlertCircle } from "lucide-react";

import { SectionHeader } from "@/components/section-header";
import { cn } from "@/lib/utils";

export const SettingsSection = function SettingsSection({
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
      <SectionHeader
        id={id}
        title={title}
        description={description}
        actions={actions}
        className="mb-3"
      />
      <div
        className={cn(
          "sheet bg-surface overflow-hidden rounded-xl",
          tone === "danger" &&
            "[--sheet-color:color-mix(in_oklch,var(--color-danger)_40%,transparent)]"
        )}
      >
        {children}
      </div>
    </section>
  );
};

export const SettingsRow = function SettingsRow({
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
    <div
      className={cn(
        "border-line grid gap-x-8 gap-y-2 border-b px-4 py-4 last:border-b-0 sm:px-5 md:grid-cols-[minmax(0,13rem)_minmax(0,1fr)]",
        align === "center" && "md:items-center",
        className
      )}
    >
      <div className="min-w-0 md:pt-2">
        <LabelTag
          {...(htmlFor ? { htmlFor } : {})}
          className="text-control text-ink block font-medium"
        >
          {label}
        </LabelTag>
        {description && (
          <p className="text-meta text-ink-subtle mt-0.5">{description}</p>
        )}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
};

export const SettingsBlock = function SettingsBlock({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "border-line border-b px-4 py-4 last:border-b-0 sm:px-5",
        className
      )}
    >
      {children}
    </div>
  );
};

export const SettingsFooter = function SettingsFooter({
  children,
  feedback,
  className,
}: {
  children?: React.ReactNode;
  feedback?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "border-line bg-surface-soft flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t px-4 py-3 sm:px-5",
        className
      )}
    >
      <div className="min-w-0 basis-full empty:hidden sm:flex-1 sm:basis-0 sm:empty:block">
        {feedback}
      </div>
      {children && (
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {children}
        </div>
      )}
    </div>
  );
};

export interface InlineFeedbackValue {
  type: "success" | "error";
  text: string;
}

export const InlineFeedback = function InlineFeedback({
  feedback,
}: {
  feedback: InlineFeedbackValue | null | undefined;
}) {
  if (!feedback) {
    return null;
  }
  const success = feedback.type === "success";
  const Icon = success ? Check : AlertCircle;
  return (
    <p
      role={success ? "status" : "alert"}
      className={cn(
        "text-control flex items-start gap-1.5",
        success ? "text-success" : "text-danger"
      )}
    >
      <Icon
        size={14}
        strokeWidth={2.25}
        aria-hidden="true"
        className="mt-0.5 shrink-0"
      />
      <span className="min-w-0 break-words">{feedback.text}</span>
    </p>
  );
};
