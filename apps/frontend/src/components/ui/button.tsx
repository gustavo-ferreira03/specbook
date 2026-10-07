"use client";

import * as React from "react";
import { Slot } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/** Shared focus recipe: 2px ink ring, 2px offset in the surrounding surface color. */
export const focusRing = "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface";

const buttonVariants = cva(
    `inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-control font-medium transition-[color,background-color,border-color,box-shadow,opacity] duration-150 ${focusRing} disabled:pointer-events-none disabled:opacity-45 aria-disabled:pointer-events-none aria-disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0`,
    {
        variants: {
            variant: {
                /** Primary action (near-black; near-white in dark): one per view. */
                default: "bg-primary text-primary-foreground shadow-xs hover:bg-primary-hover",
                primary: "bg-primary text-primary-foreground shadow-xs hover:bg-primary-hover",
                /** Secondary action with a hairline border. */
                outline: "border border-line-strong bg-surface text-ink shadow-xs hover:border-line-hover hover:bg-surface-hover",
                secondary: "border border-line-strong bg-surface text-ink shadow-xs hover:border-line-hover hover:bg-surface-hover",
                /** Quiet filled action (e.g. "Run" inside a list). */
                subtle: "bg-primary-soft text-ink hover:bg-surface-selected",
                /** Toolbar / row actions. */
                ghost: "text-ink-muted hover:bg-surface-hover hover:text-ink",
                /** Confirm destructive action (dialogs). */
                destructive: "bg-danger-solid text-danger-solid-foreground shadow-xs hover:bg-danger-solid-hover",
                /** Destructive entry point that should not shout (settings, headers). */
                "destructive-soft": "bg-danger-soft text-danger hover:bg-danger-soft-hover",
                link: "h-auto px-0 text-ink underline-offset-4 hover:underline",
            },
            size: {
                default: "h-9 px-3.5",
                md: "h-9 px-3.5",
                sm: "h-8 px-3",
                lg: "h-10 px-4 text-body",
                icon: "size-9 p-0",
                "icon-sm": "size-8 p-0",
                "icon-xs": "size-7 rounded-md p-0",
                "icon-lg": "size-10 p-0",
            },
        },
        compoundVariants: [{ variant: "link", className: "h-auto px-0" }],
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
    return <Comp data-slot="button" data-variant={variant ?? "default"} data-size={size ?? "default"} className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };
