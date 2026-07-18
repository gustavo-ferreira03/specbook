"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { BookOpenCheck, Check, Compass, Plus, Save, Trash2, X } from "lucide-react";
import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { confirmProjectContext, discardProjectContext, patchProjectContext } from "@/lib/api";
import type { ProjectContext, ProjectContextRevision } from "@/lib/types";

interface AreaDraft {
    name: string;
    routes: string;
    description: string;
}

interface PairDraft {
    first: string;
    second: string;
}

interface EditorState {
    summary: string;
    areas: AreaDraft[];
    terminology: PairDraft[];
    roles: PairDraft[];
    businessRules: string;
    uiPatterns: string;
    executionNotes: string;
    unknowns: string;
    sources: PairDraft[];
}

function toEditorState(context: ProjectContext): EditorState {
    return {
        summary: context.summary,
        areas: context.areas.map((area) => ({
            name: area.name,
            routes: area.routes.join("\n"),
            description: area.description,
        })),
        terminology: context.terminology.map((item) => ({ first: item.term, second: item.meaning })),
        roles: context.roles.map((role) => ({ first: role.name, second: role.capabilities.join("\n") })),
        businessRules: context.businessRules.join("\n"),
        uiPatterns: context.uiPatterns.join("\n"),
        executionNotes: context.executionNotes.join("\n"),
        unknowns: context.unknowns.join("\n"),
        sources: context.sources.map((source) => ({ first: source.url, second: source.note })),
    };
}

function splitLines(raw: string): string[] {
    return raw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
}

function toProjectContext(state: EditorState): ProjectContext {
    return {
        summary: state.summary.trim(),
        areas: state.areas
            .filter((area) => area.name.trim() || area.routes.trim() || area.description.trim())
            .map((area) => ({
                name: area.name.trim(),
                routes: splitLines(area.routes),
                description: area.description.trim(),
            })),
        terminology: state.terminology
            .filter((item) => item.first.trim() || item.second.trim())
            .map((item) => ({ term: item.first.trim(), meaning: item.second.trim() })),
        roles: state.roles
            .filter((role) => role.first.trim() || role.second.trim())
            .map((role) => ({ name: role.first.trim(), capabilities: splitLines(role.second) })),
        businessRules: splitLines(state.businessRules),
        uiPatterns: splitLines(state.uiPatterns),
        executionNotes: splitLines(state.executionNotes),
        unknowns: splitLines(state.unknowns),
        sources: state.sources
            .filter((source) => source.first.trim() || source.second.trim())
            .map((source) => ({ url: source.first.trim(), note: source.second.trim() })),
    };
}

function SectionLabel({ children, hint }: { children: React.ReactNode; hint?: string }) {
    return (
        <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2">
            <span className="text-[0.65625rem] font-bold text-ink-soft">{children}</span>
            {hint && <span className="text-[0.625rem] text-ink-faint">{hint}</span>}
        </div>
    );
}

export function ProjectContextEditor({
    revision,
    chatHref,
    onSaved,
    onConfirmed,
    onDiscarded,
}: {
    revision: ProjectContextRevision;
    chatHref: string | null;
    onSaved: (revision: ProjectContextRevision) => void;
    onConfirmed: (revision: ProjectContextRevision) => void;
    onDiscarded: (revision: ProjectContextRevision) => void;
}) {
    const [state, setState] = useState<EditorState>(() => toEditorState(revision.context));
    const [saving, setSaving] = useState(false);
    const [confirming, setConfirming] = useState(false);
    const [discarding, setDiscarding] = useState(false);
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [discardOpen, setDiscardOpen] = useState(false);
    const [error, setError] = useState("");
    const [discardError, setDiscardError] = useState("");
    const [focusTarget, setFocusTarget] = useState<string | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const confirmTriggerRef = useRef<HTMLButtonElement>(null);
    const discardTriggerRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        if (!focusTarget) return;
        const element = containerRef.current?.querySelector<HTMLElement>(`[data-focus="${focusTarget}"]`);
        element?.focus();
        setFocusTarget(null);
    }, [focusTarget]);

    function updateRow<K extends "areas" | "terminology" | "roles" | "sources">(
        key: K,
        index: number,
        patch: Partial<EditorState[K][number]>,
    ) {
        setState((current) => ({
            ...current,
            [key]: current[key].map((row, i) => (i === index ? { ...row, ...patch } : row)),
        }));
    }

    function addRow(key: "areas" | "terminology" | "roles" | "sources") {
        setState((current) => {
            const empty = key === "areas" ? { name: "", routes: "", description: "" } : { first: "", second: "" };
            const next = { ...current, [key]: [...current[key], empty] };
            setFocusTarget(`${key}-${current[key].length}-0`);
            return next as EditorState;
        });
    }

    function removeRow(key: "areas" | "terminology" | "roles" | "sources", index: number) {
        setState((current) => {
            const rows = current[key].filter((_, i) => i !== index);
            setFocusTarget(rows.length > 0 ? `${key}-${Math.max(0, index - 1)}-0` : `${key}-add`);
            return { ...current, [key]: rows } as EditorState;
        });
    }

    async function saveDraft(): Promise<ProjectContextRevision | null> {
        setError("");
        setSaving(true);
        try {
            const { revision: updated } = await patchProjectContext(revision.id, {
                context: toProjectContext(state),
            });
            onSaved(updated);
            return updated;
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            return null;
        } finally {
            setSaving(false);
        }
    }

    async function confirmDraft() {
        setError("");
        setConfirming(true);
        try {
            const { revision: saved } = await patchProjectContext(revision.id, {
                context: toProjectContext(state),
            });
            const { revision: confirmed } = await confirmProjectContext(saved.id);
            setConfirmOpen(false);
            onConfirmed(confirmed);
        } catch (err) {
            setConfirmOpen(false);
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setConfirming(false);
        }
    }

    async function discardDraft() {
        setDiscardError("");
        setDiscarding(true);
        try {
            const { revision: discarded } = await discardProjectContext(revision.id);
            setDiscardOpen(false);
            onDiscarded(discarded);
        } catch (err) {
            setDiscardError(err instanceof Error ? err.message : String(err));
        } finally {
            setDiscarding(false);
        }
    }

    const serialized = toProjectContext(state);
    const confirmable = serialized.summary.length > 0 && (serialized.areas.length > 0 || serialized.unknowns.length > 0);

    function pairSection(
        key: "terminology" | "roles" | "sources",
        title: string,
        hint: string,
        firstLabel: string,
        secondLabel: string,
        addLabel: string,
    ) {
        return (
            <div>
                <SectionLabel hint={hint}>{title}</SectionLabel>
                <div className="space-y-2">
                    {state[key].map((row, index) => (
                        <div key={index} className="flex items-start gap-2">
                            <div className="grid flex-1 gap-2 sm:grid-cols-2">
                                <Input
                                    data-focus={`${key}-${index}-0`}
                                    value={row.first}
                                    onChange={(event) => updateRow(key, index, { first: event.target.value })}
                                    placeholder={firstLabel}
                                    aria-label={`${title} ${index + 1}: ${firstLabel}`}
                                />
                                {key === "roles" ? (
                                    <Textarea
                                        value={row.second}
                                        onChange={(event) => updateRow(key, index, { second: event.target.value })}
                                        placeholder={secondLabel}
                                        aria-label={`${title} ${index + 1}: ${secondLabel}`}
                                        rows={2}
                                    />
                                ) : (
                                    <Input
                                        value={row.second}
                                        onChange={(event) => updateRow(key, index, { second: event.target.value })}
                                        placeholder={secondLabel}
                                        aria-label={`${title} ${index + 1}: ${secondLabel}`}
                                    />
                                )}
                            </div>
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                onClick={() => removeRow(key, index)}
                                aria-label={`Remove ${title.toLowerCase()} ${index + 1}`}
                                className="mt-0.5 shrink-0 text-ink-faint hover:text-ink"
                            >
                                <X size={14} />
                            </Button>
                        </div>
                    ))}
                    <Button type="button" variant="outline" size="sm" data-focus={`${key}-add`} onClick={() => addRow(key)}>
                        <Plus size={13} /> {addLabel}
                    </Button>
                </div>
            </div>
        );
    }

    return (
        <div ref={containerRef} className="space-y-6">
            <div>
                <Label className="mb-1.5" htmlFor="context-summary">Summary</Label>
                <Textarea
                    id="context-summary"
                    value={state.summary}
                    onChange={(event) => setState((current) => ({ ...current, summary: event.target.value }))}
                    rows={3}
                    placeholder="What this application does and who uses it"
                />
            </div>

            <div>
                <SectionLabel hint="One route per line">Areas</SectionLabel>
                <div className="space-y-3">
                    {state.areas.map((area, index) => (
                        <div key={index} className="rounded-md border border-line bg-canvas p-3">
                            <div className="flex items-start gap-2">
                                <div className="grid flex-1 gap-2 sm:grid-cols-2">
                                    <Input
                                        data-focus={`areas-${index}-0`}
                                        value={area.name}
                                        onChange={(event) => updateRow("areas", index, { name: event.target.value })}
                                        placeholder="Area name"
                                        aria-label={`Area ${index + 1} name`}
                                    />
                                    <Textarea
                                        value={area.routes}
                                        onChange={(event) => updateRow("areas", index, { routes: event.target.value })}
                                        placeholder={"/route\n/route/:id"}
                                        aria-label={`Area ${index + 1} routes`}
                                        rows={2}
                                    />
                                </div>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => removeRow("areas", index)}
                                    aria-label={`Remove area ${index + 1}`}
                                    className="mt-0.5 shrink-0 text-ink-faint hover:text-ink"
                                >
                                    <X size={14} />
                                </Button>
                            </div>
                            <Textarea
                                value={area.description}
                                onChange={(event) => updateRow("areas", index, { description: event.target.value })}
                                rows={2}
                                placeholder="What happens in this area"
                                aria-label={`Area ${index + 1} description`}
                                className="mt-2"
                            />
                        </div>
                    ))}
                    <Button type="button" variant="outline" size="sm" data-focus="areas-add" onClick={() => addRow("areas")}>
                        <Plus size={13} /> Add area
                    </Button>
                </div>
            </div>

            {pairSection("terminology", "Terminology", "Domain words and what they mean", "Term", "Meaning", "Add term")}
            {pairSection("roles", "Roles", "Enter one capability per line", "Role name", "Capabilities", "Add role")}

            <div className="grid gap-4 sm:grid-cols-2">
                <div>
                    <Label className="mb-1.5" htmlFor="context-rules">Business rules</Label>
                    <Textarea id="context-rules" value={state.businessRules} onChange={(event) => setState((current) => ({ ...current, businessRules: event.target.value }))} rows={4} placeholder="One rule per line" />
                </div>
                <div>
                    <Label className="mb-1.5" htmlFor="context-patterns">UI patterns</Label>
                    <Textarea id="context-patterns" value={state.uiPatterns} onChange={(event) => setState((current) => ({ ...current, uiPatterns: event.target.value }))} rows={4} placeholder="One pattern per line" />
                </div>
                <div>
                    <Label className="mb-1.5" htmlFor="context-notes">Execution notes</Label>
                    <Textarea id="context-notes" value={state.executionNotes} onChange={(event) => setState((current) => ({ ...current, executionNotes: event.target.value }))} rows={4} placeholder="One note per line" />
                </div>
                <div>
                    <Label className="mb-1.5" htmlFor="context-unknowns">Unknowns</Label>
                    <Textarea id="context-unknowns" value={state.unknowns} onChange={(event) => setState((current) => ({ ...current, unknowns: event.target.value }))} rows={4} placeholder="One open question per line" />
                </div>
            </div>

            {pairSection("sources", "Sources", "Pages the discovery visited", "URL", "Note", "Add source")}

            {error && (
                <Alert variant="destructive" className="text-xs" role="alert">
                    <AlertDescription>{error}</AlertDescription>
                </Alert>
            )}

            {!confirmable && (
                <p className="text-[0.625rem] leading-4 text-ink-faint">
                    Confirming needs a summary and at least one area or unknown.
                </p>
            )}

            <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
                <Button type="button" onClick={() => void saveDraft()} disabled={saving} variant="outline">
                    <Save size={14} /> {saving ? "Saving..." : "Save draft"}
                </Button>
                {chatHref && (
                    <Button asChild variant="outline">
                        <Link href={chatHref}><Compass size={14} /> Continue exploring</Link>
                    </Button>
                )}
                <Button
                    ref={confirmTriggerRef}
                    type="button"
                    onClick={() => setConfirmOpen(true)}
                    disabled={confirming || !confirmable}
                    title={confirmable ? undefined : "Confirmation needs a summary and at least one area or unknown"}
                >
                    <Check size={14} /> {confirming ? "Confirming..." : "Confirm context"}
                </Button>
                <Button
                    ref={discardTriggerRef}
                    type="button"
                    variant="ghost"
                    onClick={() => setDiscardOpen(true)}
                    disabled={discarding}
                    className="text-ink-soft"
                >
                    <Trash2 size={14} /> {discarding ? "Discarding..." : "Discard draft"}
                </Button>
            </div>

            <AlertDialog open={confirmOpen} onOpenChange={(open) => !confirming && setConfirmOpen(open)}>
                <AlertDialogContent
                    onCloseAutoFocus={(event) => {
                        const trigger = confirmTriggerRef.current;
                        if (!trigger?.isConnected) return;
                        event.preventDefault();
                        trigger.focus();
                    }}
                    onEscapeKeyDown={(event) => {
                        if (confirming) event.preventDefault();
                    }}
                >
                    <div className="flex items-start gap-3 border-b border-line px-4 py-4">
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-success-soft text-success">
                            <BookOpenCheck size={16} />
                        </span>
                        <div className="min-w-0 flex-1">
                            <AlertDialogTitle>Confirm this project context?</AlertDialogTitle>
                            <AlertDialogDescription className="mt-1.5">
                                Every future chat in this project receives it as reviewed background knowledge. Update it later with a new discovery.
                            </AlertDialogDescription>
                        </div>
                        <AlertDialogCancel
                            disabled={confirming}
                            className="size-8 border-0 bg-transparent p-0 text-ink-faint hover:bg-surface-hover hover:text-ink"
                            aria-label="Close confirmation"
                        >
                            <X size={15} />
                        </AlertDialogCancel>
                    </div>
                    <div className="flex justify-end gap-2 px-4 py-3">
                        <AlertDialogCancel disabled={confirming}>Keep editing</AlertDialogCancel>
                        <AlertDialogAction
                            disabled={confirming}
                            className="bg-primary text-primary-foreground hover:bg-primary-hover"
                            onClick={(event) => {
                                event.preventDefault();
                                void confirmDraft();
                            }}
                        >
                            {confirming ? "Confirming..." : "Confirm context"}
                        </AlertDialogAction>
                    </div>
                </AlertDialogContent>
            </AlertDialog>

            <ConfirmDeleteDialog
                open={discardOpen}
                title="Discard this draft?"
                description="The drafted context and its edits are discarded. Any previously confirmed context stays active."
                confirmLabel="Discard draft"
                busyLabel="Discarding..."
                busy={discarding}
                error={discardError}
                returnFocusRef={discardTriggerRef}
                onCancel={() => {
                    setDiscardOpen(false);
                    setDiscardError("");
                }}
                onConfirm={() => void discardDraft()}
            />
        </div>
    );
}
