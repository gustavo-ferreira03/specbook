"use client";

import * as React from "react";
import { Slot } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

export const focusRing = "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface";

const buttonVariants = cva(
    `inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-control font-medium transition-[color,background-color,border-color,box-shadow,opacity] duration-[320ms] ease-[cubic-bezier(0.22,1,0.36,1)] ${focusRing} disabled:pointer-events-none disabled:opacity-45 aria-disabled:pointer-events-none aria-disabled:opacity-45 data-[variant=default]:disabled:border-line-strong data-[variant=default]:disabled:bg-transparent data-[variant=default]:disabled:text-ink-subtle data-[variant=default]:disabled:opacity-100 data-[variant=primary]:disabled:border-line-strong data-[variant=primary]:disabled:bg-transparent data-[variant=primary]:disabled:text-ink-subtle data-[variant=primary]:disabled:opacity-100 [&_svg]:pointer-events-none [&_svg]:shrink-0`,
    {
        variants: {
            variant: {
                default: "border border-primary bg-primary text-primary-foreground hover:bg-transparent hover:text-primary hover:[&_*]:text-inherit",
                primary: "border border-primary bg-primary text-primary-foreground hover:bg-transparent hover:text-primary hover:[&_*]:text-inherit",
                outline: "border border-line-strong bg-surface text-ink hover:border-primary hover:bg-primary hover:text-primary-foreground hover:[&_*]:text-inherit",
                secondary: "border border-line-strong bg-surface text-ink hover:border-primary hover:bg-primary hover:text-primary-foreground hover:[&_*]:text-inherit",
                subtle: "border border-line bg-surface text-ink hover:border-primary hover:bg-primary hover:text-primary-foreground hover:[&_*]:text-inherit",
                ghost: "text-ink-muted hover:bg-surface-hover hover:text-ink",
                destructive: "border border-danger-solid bg-danger-solid text-danger-solid-foreground hover:bg-transparent hover:text-danger hover:[&_*]:text-inherit",
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
        compoundVariants: [
            { variant: "link", className: "h-auto px-0" },
            { variant: "ghost", size: ["icon", "icon-sm", "icon-xs", "icon-lg"], className: "hover:bg-primary! hover:text-primary-foreground! hover:[&_*]:text-inherit" },
        ],
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
