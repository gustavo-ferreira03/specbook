"use client";

import { Tabs as TabsPrimitive } from "radix-ui";
import * as React from "react";

import { cn } from "@/lib/utils";

function Tabs({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={cn("flex flex-col", className)}
      {...props}
    />
  );
}

type TabsVariant = "underline" | "segmented";
const TabsVariantContext = React.createContext<TabsVariant>("underline");

function TabsList({
  className,
  variant = "underline",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> & {
  variant?: TabsVariant;
}) {
  return (
    <TabsVariantContext.Provider value={variant}>
      <TabsPrimitive.List
        data-slot="tabs-list"
        data-variant={variant}
        className={cn(
          "flex items-center",
          variant === "underline"
            ? "border-line -ml-3 [scrollbar-width:none] gap-1 overflow-x-auto border-b py-2 pr-1 pl-0.5"
            : "border-line bg-surface inline-flex gap-0.5 rounded-lg border p-0.5",
          className
        )}
        {...props}
      />
    </TabsVariantContext.Provider>
  );
}

function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  const variant = React.useContext(TabsVariantContext);
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "text-control text-ink-muted hover:text-ink focus-visible:ring-ring data-[state=active]:text-ink inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-[color,background-color,box-shadow] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] outline-none focus-visible:ring-2 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-45 [&_svg]:shrink-0",
        variant === "underline"
          ? "tab-key px-2.5"
          : "data-[state=active]:bg-primary data-[state=active]:text-primary-foreground px-3 data-[state=active]:shadow-xs",
        className
      )}
      {...props}
    />
  );
}

function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("min-h-0 flex-1 outline-none", className)}
      {...props}
    />
  );
}

export { Tabs, TabsContent, TabsList, TabsTrigger };
