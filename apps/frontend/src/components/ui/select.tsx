"use client";

import * as React from "react";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { Select as SelectPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";
import { fieldClasses } from "./input";

const Select = SelectPrimitive.Root;
const SelectGroup = SelectPrimitive.Group;
const SelectValue = SelectPrimitive.Value;

function SelectTrigger({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Trigger>) {
    return <SelectPrimitive.Trigger data-slot="select-trigger" className={cn("flex h-9 w-full items-center justify-between gap-2 rounded-md px-3 text-left data-[placeholder]:text-ink-subtle data-[state=open]:border-line-hover [&>span]:truncate", fieldClasses, className)} {...props}>{children}<SelectPrimitive.Icon asChild><ChevronDown className="size-4 shrink-0 text-ink-subtle" /></SelectPrimitive.Icon></SelectPrimitive.Trigger>;
}

function SelectContent({ className, children, position = "popper", sideOffset = 4, ...props }: React.ComponentProps<typeof SelectPrimitive.Content>) {
    return <SelectPrimitive.Portal><SelectPrimitive.Content data-slot="select-content" position={position} sideOffset={sideOffset} className={cn("relative z-[70] max-h-[var(--radix-select-content-available-height)] max-w-[calc(100vw-24px)] min-w-[8rem] overflow-x-hidden overflow-y-auto rounded-lg border border-line bg-popover text-popover-foreground shadow-popover outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95", className)} {...props}><SelectScrollUpButton /><SelectPrimitive.Viewport className={cn("p-1", position === "popper" && "min-w-[var(--radix-select-trigger-width)] scroll-my-1")}>{children}</SelectPrimitive.Viewport><SelectScrollDownButton /></SelectPrimitive.Content></SelectPrimitive.Portal>;
}

function SelectLabel({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Label>) {
    return <SelectPrimitive.Label data-slot="select-label" className={cn("px-2 py-1.5 text-meta font-medium text-ink-subtle", className)} {...props} />;
}

function SelectItem({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Item>) {
    return <SelectPrimitive.Item data-slot="select-item" className={cn("relative flex min-h-8 w-full min-w-0 cursor-default select-none items-center overflow-hidden rounded-sm py-1.5 pr-8 pl-2.5 text-control text-ink outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-40 data-[highlighted]:bg-surface-hover data-[highlighted]:text-ink", className)} {...props}><span className="absolute right-2 flex size-4 items-center justify-center"><SelectPrimitive.ItemIndicator><Check size={14} className="text-ink" /></SelectPrimitive.ItemIndicator></span><SelectPrimitive.ItemText><span className="block truncate">{children}</span></SelectPrimitive.ItemText></SelectPrimitive.Item>;
}

function SelectSeparator({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Separator>) {
    return <SelectPrimitive.Separator data-slot="select-separator" className={cn("-mx-1 my-1 h-px bg-line", className)} {...props} />;
}

function SelectScrollUpButton({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.ScrollUpButton>) {
    return <SelectPrimitive.ScrollUpButton data-slot="select-scroll-up-button" className={cn("flex h-6 cursor-default items-center justify-center", className)} {...props}><ChevronUp className="size-3.5" /></SelectPrimitive.ScrollUpButton>;
}

function SelectScrollDownButton({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.ScrollDownButton>) {
    return <SelectPrimitive.ScrollDownButton data-slot="select-scroll-down-button" className={cn("flex h-6 cursor-default items-center justify-center", className)} {...props}><ChevronDown className="size-3.5" /></SelectPrimitive.ScrollDownButton>;
}

export { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectScrollDownButton, SelectScrollUpButton, SelectSeparator, SelectTrigger, SelectValue };
