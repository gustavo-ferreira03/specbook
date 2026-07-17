import * as React from "react";
import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
    return (
        <textarea
            data-slot="textarea"
            className={cn(
                "min-h-[34px] w-full resize-y rounded-md border border-input bg-surface px-[11px] py-2 text-[0.71875rem] font-normal leading-5 text-ink outline-none transition-[color,border-color] placeholder:text-ink-faint hover:border-line-hover disabled:pointer-events-none disabled:bg-surface-soft disabled:text-ink-faint disabled:opacity-60 aria-invalid:border-danger",
                className,
            )}
            {...props}
        />
    );
}

export { Textarea };
