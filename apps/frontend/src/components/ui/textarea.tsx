import * as React from "react";
import { cn } from "@/lib/utils";
import { fieldClasses } from "./input";

const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<"textarea">>(
    function Textarea({ className, ...props }, ref) {
        return (
            <textarea
                ref={ref}
                data-slot="textarea"
                className={cn("min-h-9 w-full resize-y rounded-md px-3 py-2 leading-5", fieldClasses, className)}
                {...props}
            />
        );
    },
);

export { Textarea };
