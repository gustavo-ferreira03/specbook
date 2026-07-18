import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const alertVariants = cva("relative w-full rounded-lg px-3 py-2.5 text-[0.6875rem] leading-5", {
    variants: {
        variant: {
            default: "bg-surface-soft text-ink",
            destructive: "bg-danger-soft text-danger",
            warning: "bg-pending-soft text-pending",
            invalid: "bg-invalid-soft text-invalid",
            conflict: "bg-conflict-soft text-conflict",
            info: "bg-info-soft text-info",
        },
    },
    defaultVariants: { variant: "default" },
});

function Alert({ className, variant, ...props }: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
    return <div data-slot="alert" className={cn(alertVariants({ variant }), className)} {...props} />;
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
    return <div data-slot="alert-title" className={cn("font-bold", className)} {...props} />;
}

function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
    return <div data-slot="alert-description" className={cn("text-current", className)} {...props} />;
}

export { Alert, AlertTitle, AlertDescription };
