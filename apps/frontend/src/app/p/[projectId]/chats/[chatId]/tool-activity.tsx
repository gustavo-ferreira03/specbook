"use client";

import { useState } from "react";
import {
    ArrowLeft,
    Camera,
    ChevronDown,
    Compass,
    FilePen,
    FilePlus2,
    FileSearch,
    FolderPlus,
    Globe,
    Hourglass,
    KeyRound,
    Keyboard,
    ListChecks,
    type LucideIcon,
    MessageSquareWarning,
    MousePointerClick,
    PanelsTopLeft,
    Play,
    Save,
    SquareCheck,
    TextCursorInput,
    Wrench,
} from "lucide-react";
import { countLabel, formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ChatToolStep } from "@/lib/types";

export type ToolStep = ChatToolStep;

interface ToolCopy {
    done: string;
    active: string;
    icon: LucideIcon;
}

const TOOL_COPY: Record<string, ToolCopy> = {
    browser_navigate: { done: "Opened page", active: "Opening page", icon: Globe },
    browser_navigate_back: { done: "Went back", active: "Going back", icon: ArrowLeft },
    browser_click: { done: "Clicked an element", active: "Clicking", icon: MousePointerClick },
    browser_hover: { done: "Hovered an element", active: "Hovering", icon: MousePointerClick },
    browser_type: { done: "Typed text", active: "Typing", icon: TextCursorInput },
    browser_fill_form: { done: "Filled a form", active: "Filling a form", icon: TextCursorInput },
    browser_press_key: { done: "Pressed a key", active: "Pressing a key", icon: Keyboard },
    browser_select_option: { done: "Selected an option", active: "Selecting an option", icon: SquareCheck },
    browser_snapshot: { done: "Took a snapshot", active: "Taking a snapshot", icon: Camera },
    browser_wait_for: { done: "Waited for the page", active: "Waiting for the page", icon: Hourglass },
    browser_handle_dialog: { done: "Handled a dialog", active: "Handling a dialog", icon: MessageSquareWarning },
    browser_tabs: { done: "Checked tabs", active: "Checking tabs", icon: PanelsTopLeft },
    browser_storage_state: { done: "Read the session state", active: "Reading the session state", icon: Save },
    browser_set_storage_state: { done: "Restored the session state", active: "Restoring the session state", icon: Save },
    save_session: { done: "Saved the browser session", active: "Saving the browser session", icon: Save },
    resume_session: { done: "Resumed the browser session", active: "Resuming the browser session", icon: Save },
    create_spec: { done: "Created Spec", active: "Creating Spec", icon: FilePlus2 },
    update_spec: { done: "Updated Spec", active: "Updating Spec", icon: FilePen },
    get_spec: { done: "Read Spec", active: "Reading Spec", icon: FileSearch },
    list_specs: { done: "Listed Specs", active: "Listing Specs", icon: ListChecks },
    run_spec: { done: "Ran Spec", active: "Running Spec", icon: Play },
    create_feature: { done: "Created feature", active: "Creating feature", icon: FolderPlus },
    list_features: { done: "Listed Features", active: "Listing Features", icon: ListChecks },
    list_credential_profiles: { done: "Checked credential profiles", active: "Checking credential profiles", icon: KeyRound },
    request_credential: { done: "Requested a credential", active: "Requesting a credential", icon: KeyRound },
    fill_secret: { done: "Filled a credential", active: "Filling a credential", icon: KeyRound },
    propose_project_context: { done: "Proposed project context", active: "Proposing project context", icon: Compass },
    get_project_context_draft: { done: "Read the context draft", active: "Reading the context draft", icon: Compass },
};

function fallbackLabel(toolName: string): string {
    const words = toolName.replace(/^browser_/, "").replace(/[_-]+/g, " ").trim();
    return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Tool";
}

export function toolCopy(toolName: string): ToolCopy {
    const known = TOOL_COPY[toolName];
    if (known) return known;
    const label = fallbackLabel(toolName);
    return { done: label, active: `Using ${label.toLowerCase()}`, icon: Wrench };
}

/** "Opening page", used by the status line while a tool runs. */
export function activeToolLabel(toolName: string): string {
    return toolCopy(toolName).active;
}

const VISIBLE_STEPS = 4;

/** Consecutive tool calls appear between the messages that preceded and followed them. */
export function TurnActivity({ steps, busy }: { steps: ToolStep[]; busy: boolean }) {
    const [expanded, setExpanded] = useState(false);
    if (steps.length === 0) return null;
    const hidden = expanded ? 0 : Math.max(0, steps.length - VISIBLE_STEPS);
    const visible = steps.slice(hidden);
    return (
        <div className="mt-3 pl-10">
            {hidden > 0 && (
                <button
                    type="button"
                    onClick={() => setExpanded(true)}
                    className="mb-1 inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-meta text-ink-subtle transition-colors hover:bg-surface-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                    <ChevronDown size={13} aria-hidden="true" />
                    {countLabel(hidden, "earlier step")}
                </button>
            )}
            <ol className="space-y-px border-l border-line pl-3" aria-label="Agent steps in this turn">
                {visible.map((step) => {
                    const copy = toolCopy(step.toolName);
                    const running = busy && step.endedAt === null;
                    const Icon = copy.icon;
                    return (
                        <li key={step.id} className="flex min-h-7 items-center gap-2 text-control">
                            <span
                                className={cn(
                                    "flex size-5 shrink-0 items-center justify-center rounded-md",
                                    running ? "bg-surface-selected text-ink" : "text-ink-subtle",
                                )}
                                aria-hidden="true"
                            >
                                <Icon size={13} strokeWidth={2} className={running ? "status-pulse" : undefined} />
                            </span>
                            <span className={cn("min-w-0 truncate", running ? "font-medium text-ink" : "text-ink-muted")}>
                                {running ? copy.active : copy.done}
                            </span>
                            {running ? (
                                <span className="sr-only">in progress</span>
                            ) : step.endedAt !== null ? (
                                <span className="shrink-0 text-meta text-ink-subtle tabular">
                                    {formatDuration(Math.max(0, (step.endedAt ?? step.startedAt) - step.startedAt))}
                                </span>
                            ) : <span className="shrink-0 text-meta text-ink-subtle">Stopped</span>}
                        </li>
                    );
                })}
            </ol>
        </div>
    );
}
