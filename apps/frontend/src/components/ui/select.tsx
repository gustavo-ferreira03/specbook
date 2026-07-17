"use client";

import * as React from "react";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { Select as SelectPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

const Select = SelectPrimitive.Root;
const SelectGroup = SelectPrimitive.Group;
const SelectValue = SelectPrimitive.Value;

function SelectTrigger({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Trigger>) {
    return <SelectPrimitive.Trigger data-slot="select-trigger" className={cn("flex h-[34px] w-full items-center justify-between gap-2 rounded-md border border-input bg-surface px-[11px] text-[0.71875rem] text-ink outline-none transition-[color,border-color] hover:border-line-hover focus-visible:outline-none focus-visible:ring-0 disabled:pointer-events-none disabled:bg-surface-soft disabled:text-ink-faint disabled:opacity-60 data-[placeholder]:text-ink-faint aria-invalid:border-danger [&>span]:truncate", className)} {...props}>{children}<SelectPrimitive.Icon asChild><ChevronDown className="size-3.5 shrink-0 text-ink-faint" /></SelectPrimitive.Icon></SelectPrimitive.Trigger>;
}

function SelectContent({ className, children, position = "popper", sideOffset = 4, ...props }: React.ComponentProps<typeof SelectPrimitive.Content>) {
    return <SelectPrimitive.Portal><SelectPrimitive.Content data-slot="select-content" position={position} sideOffset={sideOffset} className={cn("relative z-[70] max-h-[var(--radix-select-content-available-height)] max-w-[calc(100vw-24px)] min-w-[8rem] overflow-x-hidden overflow-y-auto rounded-[9px] border border-line-strong bg-popover text-popover-foreground outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95", className)} {...props}><SelectScrollUpButton /><SelectPrimitive.Viewport className={cn("p-1", position === "popper" && "min-w-[var(--radix-select-trigger-width)] scroll-my-1")}>{children}</SelectPrimitive.Viewport><SelectScrollDownButton /></SelectPrimitive.Content></SelectPrimitive.Portal>;
}

function SelectLabel({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Label>) {
    return <SelectPrimitive.Label data-slot="select-label" className={cn("px-2 py-1.5 text-[0.625rem] font-bold text-ink-faint", className)} {...props} />;
}

function SelectItem({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Item>) {
    return <SelectPrimitive.Item data-slot="select-item" className={cn("relative flex min-h-8 w-full min-w-0 cursor-default select-none items-center overflow-hidden rounded-md py-1.5 pr-8 pl-2 text-[0.6875rem] outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-40 data-[highlighted]:bg-surface-hover data-[highlighted]:text-ink", className)} {...props}><span className="absolute right-2 flex size-4 items-center justify-center"><SelectPrimitive.ItemIndicator><Check size={12} /></SelectPrimitive.ItemIndicator></span><SelectPrimitive.ItemText><span className="block truncate">{children}</span></SelectPrimitive.ItemText></SelectPrimitive.Item>;
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
