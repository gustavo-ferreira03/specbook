import { HardDrive } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { cn } from "@/lib/utils";

export const RunnerExplorationNotice = function RunnerExplorationNotice({
  className,
}: {
  className?: string;
}) {
  return (
    /* oxlint-disable jsx-a11y/prefer-tag-over-role -- Alert forwards live-region semantics to its shared native wrapper; preserve the component structure. */
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
    /* oxlint-enable jsx-a11y/prefer-tag-over-role */
  );
};
