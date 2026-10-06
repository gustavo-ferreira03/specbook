"use client";

import * as React from "react";
import { Label as LabelPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

function Label({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
    return (
        <LabelPrimitive.Root
            data-slot="label"
            className={cn("block text-control font-medium text-ink peer-disabled:cursor-not-allowed peer-disabled:opacity-50", className)}
            {...props}
        />
    );
}

export { Label };
