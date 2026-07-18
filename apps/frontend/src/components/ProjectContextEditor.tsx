"use client";

import { useEffect, useRef, useState } from "react";
import { Plus, Save, X } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { patchProjectContext } from "@/lib/api";
import type { ProjectContext, ProjectContextRevision } from "@/lib/types";
import { cn } from "@/lib/utils";

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

function AutoTextarea({ className, value, ...props }: React.ComponentProps<"textarea">) {
    const ref = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        const element = ref.current;
        if (!element) return;
        element.style.height = "auto";
        element.style.height = `${element.scrollHeight}px`;
    }, [value]);

    return (
        <Textarea
            ref={ref}
            value={value}
            onInput={(event) => {
                const element = event.currentTarget;
                element.style.height = "auto";
                element.style.height = `${element.scrollHeight}px`;
            }}
            className={cn("resize-none overflow-hidden", className)}
            {...props}
        />
    );
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
    onSaved,
    onCancel,
}: {
    revision: ProjectContextRevision;
    onSaved: (revision: ProjectContextRevision) => void;
    onCancel: () => void;
}) {
    const [state, setState] = useState<EditorState>(() => toEditorState(revision.context));
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const [focusTarget, setFocusTarget] = useState<string | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);

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
                            {key === "roles" ? (
                                <div className="flex-1 space-y-2">
                                    <Input
                                        data-focus={`${key}-${index}-0`}
                                        value={row.first}
                                        onChange={(event) => updateRow(key, index, { first: event.target.value })}
                                        placeholder={firstLabel}
                                        aria-label={`${title} ${index + 1}: ${firstLabel}`}
                                    />
                                    <AutoTextarea
                                        value={row.second}
                                        onChange={(event) => updateRow(key, index, { second: event.target.value })}
                                        placeholder={secondLabel}
                                        aria-label={`${title} ${index + 1}: ${secondLabel}`}
                                        rows={2}
                                    />
                                </div>
                            ) : (
                                <div className="grid flex-1 items-start gap-2 sm:grid-cols-2">
                                    <Input
                                        data-focus={`${key}-${index}-0`}
                                        value={row.first}
                                        onChange={(event) => updateRow(key, index, { first: event.target.value })}
                                        placeholder={firstLabel}
                                        aria-label={`${title} ${index + 1}: ${firstLabel}`}
                                        title={row.first || undefined}
                                    />
                                    <Input
                                        value={row.second}
                                        onChange={(event) => updateRow(key, index, { second: event.target.value })}
                                        placeholder={secondLabel}
                                        aria-label={`${title} ${index + 1}: ${secondLabel}`}
                                        title={row.second || undefined}
                                    />
                                </div>
                            )}
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
                <AutoTextarea
                    id="context-summary"
                    value={state.summary}
                    onChange={(event) => setState((current) => ({ ...current, summary: event.target.value }))}
                    rows={3}
                    placeholder="What this application does and who uses it"
                />
            </div>

            <div>
                <SectionLabel hint="One route per line">Areas</SectionLabel>
                <div className="space-y-5">
                    {state.areas.map((area, index) => (
                        <div key={index} className={index > 0 ? "space-y-2 border-t border-line pt-5" : "space-y-2"}>
                            <div className="flex items-start gap-2">
                                <Input
                                    data-focus={`areas-${index}-0`}
                                    value={area.name}
                                    onChange={(event) => updateRow("areas", index, { name: event.target.value })}
                                    placeholder="Area name"
                                    aria-label={`Area ${index + 1} name`}
                                    className="flex-1"
                                />
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => removeRow("areas", index)}
                                    aria-label={`Remove area ${index + 1}`}
                                    className="shrink-0 text-ink-faint hover:text-ink"
                                >
                                    <X size={14} />
                                </Button>
                            </div>
                            <AutoTextarea
                                value={area.routes}
                                onChange={(event) => updateRow("areas", index, { routes: event.target.value })}
                                placeholder={"/route\n/route/:id"}
                                aria-label={`Area ${index + 1} routes`}
                                rows={2}
                            />
                            <AutoTextarea
                                value={area.description}
                                onChange={(event) => updateRow("areas", index, { description: event.target.value })}
                                rows={2}
                                placeholder="What happens in this area"
                                aria-label={`Area ${index + 1} description`}
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
                    <AutoTextarea id="context-rules" value={state.businessRules} onChange={(event) => setState((current) => ({ ...current, businessRules: event.target.value }))} rows={4} placeholder="One rule per line" />
                </div>
                <div>
                    <Label className="mb-1.5" htmlFor="context-patterns">UI patterns</Label>
                    <AutoTextarea id="context-patterns" value={state.uiPatterns} onChange={(event) => setState((current) => ({ ...current, uiPatterns: event.target.value }))} rows={4} placeholder="One pattern per line" />
                </div>
                <div>
                    <Label className="mb-1.5" htmlFor="context-notes">Execution notes</Label>
                    <AutoTextarea id="context-notes" value={state.executionNotes} onChange={(event) => setState((current) => ({ ...current, executionNotes: event.target.value }))} rows={4} placeholder="One note per line" />
                </div>
                <div>
                    <Label className="mb-1.5" htmlFor="context-unknowns">Unknowns</Label>
                    <AutoTextarea id="context-unknowns" value={state.unknowns} onChange={(event) => setState((current) => ({ ...current, unknowns: event.target.value }))} rows={4} placeholder="One open question per line" />
                </div>
            </div>

            {pairSection("sources", "Sources", "Pages the discovery visited", "URL", "Note", "Add source")}

            {error && (
                <Alert variant="destructive" className="text-xs" role="alert">
                    <AlertDescription>{error}</AlertDescription>
                </Alert>
            )}

            <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
                <Button type="button" onClick={() => void saveDraft()} disabled={saving}>
                    <Save size={14} /> {saving ? "Saving..." : "Save changes"}
                </Button>
                <Button type="button" variant="ghost" onClick={onCancel} disabled={saving} className="text-ink-soft">
                    Cancel
                </Button>
            </div>
        </div>
    );
}
