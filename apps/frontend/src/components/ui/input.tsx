import * as React from "react";
import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
    return (
        <input
            type={type}
            data-slot="input"
            className={cn(
                "h-[34px] w-full min-w-0 rounded-md border border-input bg-surface px-[11px] text-[0.71875rem] text-ink outline-none transition-[color,border-color] placeholder:text-ink-faint hover:border-line-hover disabled:pointer-events-none disabled:bg-surface-soft disabled:text-ink-faint disabled:opacity-60 aria-invalid:border-danger",
                className,
            )}
            {...props}
        />
    );
}

export { Input };
