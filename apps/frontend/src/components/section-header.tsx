import { cn } from "@/lib/utils";

export const SectionHeader = function SectionHeader({
  title,
  description,
  count,
  actions,
  as: Heading = "h2",
  id,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  count?: number;
  actions?: React.ReactNode;
  as?: "h2" | "h3";
  id?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-8 flex-wrap items-center justify-between gap-x-4 gap-y-2",
        className
      )}
    >
      <div className="min-w-0">
        <Heading
          id={id}
          className="text-section text-ink flex items-baseline gap-2"
        >
          <span className="min-w-0">{title}</span>
          {count !== undefined && (
            <span className="tabular text-control text-ink-subtle font-normal">
              {count}
            </span>
          )}
        </Heading>
        {description && (
          <p className="text-control text-ink-muted mt-0.5">{description}</p>
        )}
      </div>
      {actions && (
        <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">
          {actions}
        </div>
      )}
    </div>
  );
};
