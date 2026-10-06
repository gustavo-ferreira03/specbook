import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/** Tones: info, success, warning, danger (alias: destructive), invalid, conflict, default (neutral). */
const alertVariants = cva("relative w-full rounded-lg border px-3.5 py-3 text-control leading-5 [&_a]:font-medium [&_a]:underline [&_a]:underline-offset-2", {
    variants: {
        variant: {
            default: "border-line bg-surface-soft text-ink",
            info: "border-info/15 bg-info-soft text-info",
            success: "border-success/15 bg-success-soft text-success",
            // Amber text on cream reads as brown, so the warning tone keeps neutral text and
            // carries the amber in the border and icon.
            warning: "border-warning-chart/60 bg-warning-soft text-ink [&_svg]:text-warning-icon",
            danger: "border-danger/15 bg-danger-soft text-danger",
            destructive: "border-danger/15 bg-danger-soft text-danger",
            invalid: "border-invalid/15 bg-invalid-soft text-invalid",
            conflict: "border-conflict/15 bg-conflict-soft text-conflict",
        },
    },
    defaultVariants: { variant: "default" },
});

function Alert({ className, variant, ...props }: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
    return <div data-slot="alert" className={cn(alertVariants({ variant }), className)} {...props} />;
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
    return <div data-slot="alert-title" className={cn("font-semibold", className)} {...props} />;
}

function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
    return <div data-slot="alert-description" className={cn("text-current [&:not(:first-child)]:mt-0.5 [&:not(:first-child)]:opacity-90", className)} {...props} />;
}

export { Alert, AlertTitle, AlertDescription };
