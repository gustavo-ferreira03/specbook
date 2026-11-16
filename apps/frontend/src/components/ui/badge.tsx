import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import * as React from "react";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "text-meta inline-flex h-6 w-fit shrink-0 items-center justify-center gap-1 rounded-full border border-current/40 px-2 font-medium whitespace-nowrap [font-variant-numeric:tabular-nums] [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground",
        secondary: "border-line text-ink-muted border",
        neutral: "bg-neutral-soft text-ink-muted",
        outline: "border-line-strong text-ink-muted border",
        success: "bg-success-soft text-success",
        danger: "bg-danger-soft text-danger",
        warning: "bg-warning-soft text-ink [&_svg]:text-warning-icon",
        invalid: "bg-invalid-soft text-invalid",
        conflict: "bg-conflict-soft text-conflict",
        info: "bg-info-soft text-info",
        running: "bg-running-soft text-running",
      },
      size: {
        default: "",
        sm: "h-5 px-1.5",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
);

type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>["variant"]>;

function Badge({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span";
  return (
    <Comp
      data-slot="badge"
      className={cn(badgeVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants, type BadgeVariant };
