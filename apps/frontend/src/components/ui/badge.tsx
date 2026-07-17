import * as React from "react";
import { Slot } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
    "inline-flex w-fit shrink-0 items-center justify-center gap-1 rounded-full px-2 py-1 text-[0.625rem] font-bold whitespace-nowrap [&_svg]:pointer-events-none [&_svg]:shrink-0",
    {
        variants: {
            variant: {
                default: "bg-primary text-primary-foreground",
                secondary: "bg-primary-soft text-ink-soft",
                outline: "border border-line text-ink-soft",
                success: "bg-success-soft text-success",
                danger: "bg-danger-soft text-danger",
                pending: "bg-pending-soft text-pending",
                info: "bg-info-soft text-info",
            },
        },
        defaultVariants: { variant: "default" },
    },
);

function Badge({ className, variant, asChild = false, ...props }: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
    const Comp = asChild ? Slot.Root : "span";
    return <Comp data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
