import { HardDrive } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { cn } from "@/lib/utils";

export function RunnerExplorationNotice({ className }: { className?: string }) {
  return (
    <Alert className={cn("flex items-start gap-3", className)} role="status">
      <HardDrive
        size={16}
        className="text-ink-muted mt-0.5 shrink-0"
        aria-hidden="true"
      />
      <div>
        <AlertTitle>Agent browser exploration is unavailable</AlertTitle>
        <AlertDescription>
          Production runs on a private-network runner. Use the local CLI to
          explore the app and publish Specs. Hosted chats can discuss saved
          Specs and run evidence.
        </AlertDescription>
      </div>
    </Alert>
  );
}
