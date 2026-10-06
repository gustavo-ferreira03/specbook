"use client";

import * as React from "react";
import { Check, ChevronRight, Circle } from "lucide-react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

const DropdownMenu = DropdownMenuPrimitive.Root;
const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
const DropdownMenuGroup = DropdownMenuPrimitive.Group;
const DropdownMenuPortal = DropdownMenuPrimitive.Portal;
const DropdownMenuSub = DropdownMenuPrimitive.Sub;
const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;

function DropdownMenuContent({ className, sideOffset = 6, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
    return (
        <DropdownMenuPrimitive.Portal>
            <DropdownMenuPrimitive.Content data-slot="dropdown-menu-content" sideOffset={sideOffset} className={cn("z-50 max-h-[var(--radix-dropdown-menu-content-available-height)] min-w-40 overflow-x-hidden overflow-y-auto rounded-lg border border-line bg-popover p-1 text-popover-foreground shadow-popover outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95", className)} {...props} />
        </DropdownMenuPrimitive.Portal>
    );
}

function DropdownMenuItem({ className, inset, variant = "default", ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & { inset?: boolean; variant?: "default" | "destructive" }) {
    return <DropdownMenuPrimitive.Item data-slot="dropdown-menu-item" data-inset={inset} data-variant={variant} className={cn("relative flex min-h-8 cursor-default select-none items-center gap-2 rounded-sm px-2.5 text-control text-ink outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-40 data-[inset]:pl-8 data-[highlighted]:bg-surface-hover data-[highlighted]:text-ink data-[variant=destructive]:text-danger [&_svg:not([class*=text-])]:text-ink-subtle data-[variant=destructive]:[&_svg]:text-danger data-[variant=destructive]:data-[highlighted]:bg-danger-soft [&_svg]:pointer-events-none [&_svg]:shrink-0", className)} {...props} />;
}

function DropdownMenuCheckboxItem({ className, children, checked, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>) {
    return (
        <DropdownMenuPrimitive.CheckboxItem data-slot="dropdown-menu-checkbox-item" className={cn("relative flex min-h-8 cursor-default select-none items-center rounded-sm py-1.5 pr-2 pl-8 text-control text-ink outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-40 data-[highlighted]:bg-surface-hover", className)} checked={checked} {...props}>
            <span className="pointer-events-none absolute left-2 flex size-4 items-center justify-center"><DropdownMenuPrimitive.ItemIndicator><Check size={14} className="text-ink" /></DropdownMenuPrimitive.ItemIndicator></span>
            {children}
        </DropdownMenuPrimitive.CheckboxItem>
    );
}

function DropdownMenuRadioItem({ className, children, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
    return (
        <DropdownMenuPrimitive.RadioItem data-slot="dropdown-menu-radio-item" className={cn("relative flex min-h-8 cursor-default select-none items-center rounded-sm py-1.5 pr-2 pl-8 text-control text-ink outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-40 data-[highlighted]:bg-surface-hover", className)} {...props}>
            <span className="pointer-events-none absolute left-2 flex size-4 items-center justify-center"><DropdownMenuPrimitive.ItemIndicator><Circle className="size-2 fill-current text-ink" /></DropdownMenuPrimitive.ItemIndicator></span>
            {children}
        </DropdownMenuPrimitive.RadioItem>
    );
}

function DropdownMenuLabel({ className, inset, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Label> & { inset?: boolean }) {
    return <DropdownMenuPrimitive.Label data-slot="dropdown-menu-label" data-inset={inset} className={cn("px-2.5 pt-2 pb-1 text-meta font-medium text-ink-subtle data-[inset]:pl-8", className)} {...props} />;
}

function DropdownMenuSeparator({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
    return <DropdownMenuPrimitive.Separator data-slot="dropdown-menu-separator" className={cn("-mx-1 my-1 h-px bg-line", className)} {...props} />;
}

function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<"span">) {
    return <span data-slot="dropdown-menu-shortcut" className={cn("ml-auto text-meta tracking-widest text-ink-subtle", className)} {...props} />;
}

function DropdownMenuSubTrigger({ className, inset, children, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger> & { inset?: boolean }) {
    return <DropdownMenuPrimitive.SubTrigger data-slot="dropdown-menu-sub-trigger" data-inset={inset} className={cn("flex min-h-8 cursor-default select-none items-center rounded-sm px-2.5 text-control text-ink outline-none data-[inset]:pl-8 data-[state=open]:bg-surface-hover data-[highlighted]:bg-surface-hover", className)} {...props}>{children}<ChevronRight className="ml-auto size-3.5" /></DropdownMenuPrimitive.SubTrigger>;
}

function DropdownMenuSubContent({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
    return <DropdownMenuPrimitive.SubContent data-slot="dropdown-menu-sub-content" className={cn("z-50 min-w-40 rounded-lg border border-line bg-popover p-1 text-popover-foreground shadow-popover outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0", className)} {...props} />;
}

export { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuPortal, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger };
