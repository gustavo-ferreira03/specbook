"use client";

import * as React from "react";
import { Slot } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
    "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-[0.6875rem] font-bold transition-[color,background-color,border-color,opacity] duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring/35 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:shrink-0",
    {
        variants: {
            variant: {
                default: "bg-primary text-primary-foreground hover:bg-primary-hover",
                destructive: "bg-danger-soft text-danger hover:bg-danger-hover",
                outline: "border border-line-strong bg-surface text-ink hover:border-line-hover hover:bg-surface-soft",
                secondary: "bg-secondary text-secondary-foreground hover:bg-surface-hover",
                ghost: "text-ink-soft hover:bg-surface-hover hover:text-ink",
                link: "text-ink underline-offset-4 hover:underline",
            },
            size: {
                default: "h-8 px-[11px]",
                sm: "h-7 rounded-md px-2 text-[0.625rem]",
                lg: "h-9 px-4 text-xs",
                icon: "size-8 p-0",
                "icon-sm": "size-7 p-0",
                "icon-lg": "size-10 p-0",
            },
        },
        defaultVariants: {
            variant: "default",
            size: "default",
        },
    },
);

function Button({
    className,
    variant,
    size,
    asChild = false,
    ...props
}: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
    const Comp = asChild ? Slot.Root : "button";
    return <Comp data-slot="button" data-variant={variant} data-size={size} className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };
