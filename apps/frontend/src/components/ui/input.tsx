import * as React from "react";
import { cn } from "@/lib/utils";

export const fieldClasses = "border border-line-strong bg-surface text-control text-ink shadow-xs outline-none transition-[color,border-color,box-shadow] duration-150 placeholder:text-ink-subtle hover:border-line-hover focus-visible:border-line-hover focus-visible:ring-3 focus-visible:ring-ring/12 disabled:pointer-events-none disabled:bg-surface-soft disabled:text-ink-subtle disabled:opacity-70 aria-invalid:border-danger aria-invalid:focus-visible:ring-danger/20";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
    return (
        <input
            type={type}
            data-slot="input"
            className={cn("h-9 w-full min-w-0 rounded-md px-3 file:mr-3 file:border-0 file:bg-transparent file:text-control file:font-medium", fieldClasses, className)}
            {...props}
        />
    );
}

export { Input };
