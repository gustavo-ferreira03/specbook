"use client";

import * as React from "react";
import { Tabs as TabsPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

function Tabs({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
    return <TabsPrimitive.Root data-slot="tabs" className={cn("flex flex-col", className)} {...props} />;
}

/**
 * `underline` (default): page-level tabs with an primary (ink) indicator under the active tab.
 * `segmented`: compact switch inside a tinted track.
 */
function TabsList({ className, variant = "underline", ...props }: React.ComponentProps<typeof TabsPrimitive.List> & { variant?: "underline" | "segmented" }) {
    return (
        <TabsPrimitive.List
            data-slot="tabs-list"
            data-variant={variant}
            className={cn(
                "group/tabs flex items-center",
                variant === "underline" ? "gap-5 overflow-x-auto border-b border-line [scrollbar-width:none]" : "inline-flex gap-0.5 rounded-lg border border-line bg-surface p-0.5",
                className,
            )}
            {...props}
        />
    );
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
    return (
        <TabsPrimitive.Trigger
            data-slot="tabs-trigger"
            className={cn(
                "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap text-control font-medium text-ink-muted outline-none transition-[color,background-color,border-color,box-shadow] duration-150 hover:text-ink focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-45 [&_svg]:shrink-0",
                "group-data-[variant=underline]/tabs:relative group-data-[variant=underline]/tabs:-mb-px group-data-[variant=underline]/tabs:h-10 group-data-[variant=underline]/tabs:rounded-t-sm group-data-[variant=underline]/tabs:border-b-2 group-data-[variant=underline]/tabs:border-transparent group-data-[variant=underline]/tabs:px-0.5 group-data-[variant=underline]/tabs:data-[state=active]:border-primary group-data-[variant=underline]/tabs:data-[state=active]:text-ink",
                "group-data-[variant=segmented]/tabs:h-8 group-data-[variant=segmented]/tabs:rounded-md group-data-[variant=segmented]/tabs:px-3 group-data-[variant=segmented]/tabs:data-[state=active]:bg-primary group-data-[variant=segmented]/tabs:data-[state=active]:text-primary-foreground",
                className,
            )}
            {...props}
        />
    );
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
    return <TabsPrimitive.Content data-slot="tabs-content" className={cn("min-h-0 flex-1 outline-none", className)} {...props} />;
}

export { Tabs, TabsContent, TabsList, TabsTrigger };
