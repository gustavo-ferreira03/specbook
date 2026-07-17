"use client";

import * as React from "react";
import { X } from "lucide-react";
import { Dialog as SheetPrimitive } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const Sheet = SheetPrimitive.Root;
const SheetTrigger = SheetPrimitive.Trigger;
const SheetClose = SheetPrimitive.Close;
const SheetPortal = SheetPrimitive.Portal;

function SheetOverlay({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Overlay>) {
    return <SheetPrimitive.Overlay data-slot="sheet-overlay" className={cn("fixed inset-0 z-40 bg-overlay-soft data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0", className)} {...props} />;
}

const sheetVariants = cva("fixed z-50 flex flex-col bg-sidebar outline-none transition duration-200 ease-out data-[state=open]:animate-in data-[state=closed]:animate-out motion-reduce:transition-none", {
    variants: {
        side: {
            top: "inset-x-0 top-0 border-b border-line data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top",
            bottom: "inset-x-0 bottom-0 border-t border-line data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom",
            left: "inset-y-0 left-0 h-full border-r border-line data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left",
            right: "inset-y-0 right-0 h-full border-l border-line data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right",
        },
    },
    defaultVariants: { side: "right" },
});

function SheetContent({ side = "right", className, children, showCloseButton = true, ...props }: React.ComponentProps<typeof SheetPrimitive.Content> & VariantProps<typeof sheetVariants> & { showCloseButton?: boolean }) {
    return (
        <SheetPortal>
            <SheetOverlay />
            <SheetPrimitive.Content data-slot="sheet-content" className={cn(sheetVariants({ side }), className)} {...props}>
                {children}
                {showCloseButton && <SheetPrimitive.Close className="absolute top-3 right-3 flex size-8 items-center justify-center rounded-md text-ink-faint outline-none hover:bg-surface-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-ring/35"><X size={16} /><span className="sr-only">Close</span></SheetPrimitive.Close>}
            </SheetPrimitive.Content>
        </SheetPortal>
    );
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
    return <div data-slot="sheet-header" className={cn("flex flex-col gap-1.5", className)} {...props} />;
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
    return <div data-slot="sheet-footer" className={cn("mt-auto flex flex-col gap-2", className)} {...props} />;
}

function SheetTitle({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Title>) {
    return <SheetPrimitive.Title data-slot="sheet-title" className={cn("text-[0.8125rem] font-bold", className)} {...props} />;
}

function SheetDescription({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Description>) {
    return <SheetPrimitive.Description data-slot="sheet-description" className={cn("text-[0.6875rem] text-ink-soft", className)} {...props} />;
}

export { Sheet, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetOverlay, SheetPortal, SheetTitle, SheetTrigger };
