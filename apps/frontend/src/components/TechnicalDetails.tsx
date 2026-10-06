import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

export function TechnicalDetails({ children }: { children: React.ReactNode }) {
    return (
        <Collapsible className="group/details">
            <CollapsibleTrigger asChild>
                <Button type="button" variant="ghost" size="sm" className="-ml-2 text-ink-subtle">
                    <ChevronDown size={13} className="transition-transform group-data-[state=open]/details:rotate-180 motion-reduce:transition-none" aria-hidden="true" />
                    Technical details
                </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2 space-y-4">{children}</CollapsibleContent>
        </Collapsible>
    );
}
