import * as React from "react";
import { Slot } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
    "inline-flex h-6 w-fit shrink-0 items-center justify-center gap-1 rounded-full px-2 text-meta font-medium whitespace-nowrap [font-variant-numeric:tabular-nums] [&_svg]:pointer-events-none [&_svg]:shrink-0",
    {
        variants: {
            variant: {
                default: "bg-primary text-primary-foreground",
                secondary: "bg-surface-hover text-ink-muted",
                neutral: "bg-neutral-soft text-ink-muted",
                outline: "border border-line-strong text-ink-muted",
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
    },
);

type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>["variant"]>;

function Badge({ className, variant, size, asChild = false, ...props }: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
    const Comp = asChild ? Slot.Root : "span";
    return <Comp data-slot="badge" className={cn(badgeVariants({ variant, size }), className)} {...props} />;
}

export { Badge, badgeVariants, type BadgeVariant };
