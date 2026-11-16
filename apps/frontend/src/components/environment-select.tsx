"use client";

import { RefreshCw } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { errorMessage, getEnvironments, isAbortError } from "@/lib/api";
import { matchesInvalidation, onInvalidate } from "@/lib/invalidation";
import type { ProjectEnvironment } from "@/lib/types";
import { cn } from "@/lib/utils";

export const EnvironmentSelect = function EnvironmentSelect({
  projectId,
  value,
  onValueChange,
  disabled = false,
  className,
}: {
  projectId: string;
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  const [environments, setEnvironments] = useState<ProjectEnvironment[]>([]);
  const [error, setError] = useState("");
  const [retryKey, setRetryKey] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    // oxlint-disable-next-line react/set-state-in-effect -- Reset the previous request or selection when its external key changes before loading fresh state.
    setError("");
    (async () => {
      try {
        const resolvedValue = await getEnvironments(
          projectId,
          controller.signal
        );
        const result = resolvedValue;
        setEnvironments(result.environments);
      } catch (error_) {
        if (!isAbortError(error_)) {
          setError(errorMessage(error_));
        }
      }
    })();
    return () => controller.abort();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- This dependency intentionally triggers a retry, navigation reset, or DOM measurement without being read by the effect.
  }, [projectId, retryKey]);
  useEffect(
    () =>
      onInvalidate((event) => {
        if (matchesInvalidation(event, "projects", projectId)) {
          setRetryKey((key) => key + 1);
        }
      }),
    [projectId]
  );
  const loaded = environments.length > 0;
  useEffect(() => {
    if (
      loaded &&
      !environments.some((environment) => environment.name === value)
    ) {
      onValueChange("Production");
    }
  }, [loaded, environments, value, onValueChange]);
  if (!error && environments.length <= 1) {
    return null;
  }
  return (
    <div className={cn("min-w-0", className)}>
      <label htmlFor={id} className="sr-only">
        Run environment
      </label>
      <Select value={value} onValueChange={onValueChange} disabled={disabled}>
        <SelectTrigger
          id={id}
          className="h-8 w-36"
          aria-label="Run environment"
        >
          <SelectValue>{value}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {environments.map((environment) => (
            <SelectItem key={environment.id} value={environment.name}>
              {environment.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error && (
        <div
          className="text-meta text-danger mt-1 flex items-center gap-1"
          role="alert"
          title={error}
        >
          <span>Could not load environments</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => setRetryKey((key) => key + 1)}
            aria-label="Reload environments"
          >
            <RefreshCw size={12} />
          </Button>
        </div>
      )}
    </div>
  );
};
