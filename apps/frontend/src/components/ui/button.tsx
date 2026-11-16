"use client";

import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import * as React from "react";

import { cn } from "@/lib/utils";

export const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface";

const buttonVariants = cva(
  `text-control inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow,opacity,translate] duration-[320ms] ease-[cubic-bezier(0.22,1,0.36,1)] select-none ${focusRing} data-[variant=default]:disabled:border-line-strong data-[variant=default]:disabled:text-ink-subtle data-[variant=primary]:disabled:border-line-strong data-[variant=primary]:disabled:text-ink-subtle disabled:pointer-events-none disabled:opacity-45 aria-disabled:pointer-events-none aria-disabled:opacity-45 data-[variant=default]:disabled:bg-transparent data-[variant=default]:disabled:opacity-100 data-[variant=primary]:disabled:bg-transparent data-[variant=primary]:disabled:opacity-100 [&_svg]:pointer-events-none [&_svg]:shrink-0`,
  {
    variants: {
      variant: {
        default:
          "key border-primary bg-primary text-primary-foreground hover:text-primary border-(length:--stroke) [--key:var(--color-primary)] hover:bg-transparent hover:[&_*]:text-inherit",
        primary:
          "key border-primary bg-primary text-primary-foreground hover:text-primary border-(length:--stroke) [--key:var(--color-primary)] hover:bg-transparent hover:[&_*]:text-inherit",
        outline:
          "key [&[aria-haspopup]]:border-line-strong bg-surface text-ink hover:border-primary hover:bg-primary hover:text-primary-foreground [&[aria-haspopup]:hover]:border-line-hover [&[aria-haspopup]:hover]:bg-surface [&[aria-haspopup]:hover]:text-ink border-(length:--stroke) border-(--stroke-ink) [--key:var(--stroke-ink)] hover:[&_*]:text-inherit [&[aria-haspopup]]:shadow-none",
        secondary:
          "key [&[aria-haspopup]]:border-line-strong bg-surface text-ink hover:border-primary hover:bg-primary hover:text-primary-foreground [&[aria-haspopup]:hover]:border-line-hover [&[aria-haspopup]:hover]:bg-surface [&[aria-haspopup]:hover]:text-ink border-(length:--stroke) border-(--stroke-ink) [--key:var(--stroke-ink)] hover:[&_*]:text-inherit [&[aria-haspopup]]:shadow-none",
        subtle:
          "key [&[aria-haspopup]]:border-line-strong bg-surface text-ink hover:border-primary hover:bg-primary hover:text-primary-foreground [&[aria-haspopup]:hover]:border-line-hover [&[aria-haspopup]:hover]:bg-surface [&[aria-haspopup]:hover]:text-ink border-(length:--stroke) border-(--stroke-ink) [--key:var(--stroke-ink)] hover:[&_*]:text-inherit [&[aria-haspopup]]:shadow-none",
        ghost: "text-ink-muted hover:bg-surface-hover hover:text-ink",
        quiet: "text-ink-subtle hover:text-ink",
        destructive:
          "key border-danger-solid bg-danger-solid text-danger-solid-foreground hover:text-danger border-(length:--stroke) [--key:var(--color-danger-solid)] hover:bg-transparent hover:[&_*]:text-inherit",
        "destructive-soft":
          "bg-danger-soft text-danger hover:bg-danger-soft-hover",
        link: "text-ink h-auto px-0 underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-3.5",
        md: "h-9 px-3.5",
        sm: "h-8 px-3",
        lg: "text-body h-10 px-4",
        icon: "size-9 p-0",
        "icon-sm": "size-8 p-0",
        "icon-xs": "size-7 rounded-md p-0",
        "icon-lg": "size-10 p-0",
      },
    },
    compoundVariants: [
      { variant: "link", className: "h-auto px-0" },
      {
        variant: "ghost",
        size: ["icon", "icon-sm", "icon-xs", "icon-lg"],
        className:
          "hover:bg-primary! hover:text-primary-foreground! hover:[&_*]:text-inherit",
      },
    ],
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp
      data-slot="button"
      data-variant={variant ?? "default"}
      data-size={size ?? "default"}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
