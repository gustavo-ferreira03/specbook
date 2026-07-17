"use client";

import * as React from "react";
import { ScrollArea as ScrollAreaPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

function ScrollArea({ className, children, orientation = "vertical", ...props }: React.ComponentProps<typeof ScrollAreaPrimitive.Root> & { orientation?: "vertical" | "horizontal" }) {
    return <ScrollAreaPrimitive.Root data-slot="scroll-area" className={cn("relative overflow-hidden", className)} {...props}><ScrollAreaPrimitive.Viewport data-slot="scroll-area-viewport" className={cn("size-full rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-ring/25", orientation === "vertical" && "[&>div]:!block [&>div]:!w-full [&>div]:!min-w-0")}>{children}</ScrollAreaPrimitive.Viewport><ScrollBar orientation={orientation} /><ScrollAreaPrimitive.Corner /></ScrollAreaPrimitive.Root>;
}

function ScrollBar({ className, orientation = "vertical", ...props }: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
    return <ScrollAreaPrimitive.ScrollAreaScrollbar data-slot="scroll-area-scrollbar" orientation={orientation} className={cn("flex touch-none select-none p-px transition-colors data-[orientation=horizontal]:h-2 data-[orientation=horizontal]:flex-col data-[orientation=vertical]:h-full data-[orientation=vertical]:w-2", className)} {...props}><ScrollAreaPrimitive.ScrollAreaThumb data-slot="scroll-area-thumb" className="relative flex-1 rounded-full bg-line-strong" /></ScrollAreaPrimitive.ScrollAreaScrollbar>;
}

export { ScrollArea, ScrollBar };
