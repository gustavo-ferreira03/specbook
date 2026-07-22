"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useEffect, useRef, useState } from "react";
import { Folder, LoaderCircle, Play, RefreshCw, Trash2 } from "lucide-react";
import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { FeatureEditDialog } from "@/components/FeatureEditDialog";
import { PageHeader } from "@/components/PageHeader";
import { StatusPill } from "@/components/StatusPill";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, startRunBatch } from "@/lib/api";
import type { Feature, SpecStatus, SpecSummary } from "@/lib/types";

function StatTile({ label, value, tone }: { label: string; value: number; tone?: "success" | "danger" | "pending" }) {
    const toneClass = tone === "success" ? "text-success" : tone === "danger" ? "text-danger" : tone === "pending" ? "text-pending" : "text-ink";
    return (
        <div className="rounded-[13px] border border-line bg-surface p-4">
            <p className="text-[0.625rem] font-bold tracking-[0.08em] text-ink-faint uppercase">{label}</p>
            <p className={`mt-1.5 text-xl font-bold tracking-[-0.02em] tabular-nums ${toneClass}`}>{value}</p>
        </div>
    );
}

export default function FeaturePage({ params }: { params: Promise<{ projectId: string; featureId: string }> }) {
    const { projectId, featureId } = use(params);
    const router = useRouter();
    const [features, setFeatures] = useState<Feature[] | null>(null);
    const [specs, setSpecs] = useState<SpecSummary[] | null>(null);
    const [loadError, setLoadError] = useState("");
    const [retryKey, setRetryKey] = useState(0);
    const [running, setRunning] = useState(false);
    const [deleteOpen, setDeleteOpen] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [deleteError, setDeleteError] = useState("");
    const deleteTriggerRef = useRef<HTMLElement | null>(null);

    useEffect(() => {
        let active = true;
        setLoadError("");
        api<{ features: Feature[]; specs: SpecSummary[]; syncError: string | null }>(`/projects/${projectId}/tree`)
            .then((result) => {
                if (!active) return;
                setFeatures(result.features);
                setSpecs(result.specs);
            })
            .catch((error) => {
                if (!active) return;
                setLoadError(error instanceof Error ? error.message : String(error));
            });
        return () => {
            active = false;
        };
    }, [projectId, featureId, retryKey]);

    if (loadError) {
        return (
            <div className="flex min-h-full flex-col bg-surface">
                <PageHeader title="Feature" eyebrow="Project" />
                <div className="flex flex-1 items-center justify-center px-5 py-10">
                    <Alert variant="destructive" className="w-full max-w-sm bg-transparent text-center" role="alert">
                        <AlertDescription className="text-xs leading-5">{loadError}</AlertDescription>
                        <Button type="button" onClick={() => setRetryKey((key) => key + 1)} className="mx-auto mt-4">
                            <RefreshCw size={14} /> Try again
                        </Button>
                    </Alert>
                </div>
            </div>
        );
    }

    if (!features || !specs) {
        return (
            <div className="flex min-h-full flex-col bg-surface" aria-busy="true" role="status">
                <span className="sr-only">Loading feature</span>
                <PageHeader title="Feature" eyebrow="Project" />
                <div className="mx-auto w-full max-w-[1040px] space-y-4 px-5 py-8">
                    <Skeleton className="h-16 rounded-[13px]" />
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                        {Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-20 rounded-[13px]" />)}
                    </div>
                    <Skeleton className="h-48 rounded-[13px]" />
                </div>
            </div>
        );
    }

    const feature = features.find((item) => item.id === featureId);
    if (!feature) {
        return (
            <div className="flex min-h-full flex-col bg-surface">
                <PageHeader title="Feature not found" eyebrow="Project" />
                <div className="flex flex-1 items-center justify-center px-5 py-10">
                    <div className="max-w-sm text-center">
                        <p className="text-xs leading-5 text-ink-faint">This feature no longer exists.</p>
                        <Button asChild className="mt-4">
                            <Link href={`/p/${projectId}/specs`}>Back to Specs</Link>
                        </Button>
                    </div>
                </div>
            </div>
        );
    }

    const knownFeatureIds = new Set(features.map((item) => item.id));
    const parentFeature = feature.parentId && knownFeatureIds.has(feature.parentId)
        ? features.find((item) => item.id === feature.parentId) ?? null
        : null;
    const childFeatures = features.filter((item) => item.parentId === feature.id);
    const directSpecs = specs.filter((spec) => spec.featureId === feature.id);

    function descendantIds(rootId: string): Set<string> {
        const ids = new Set([rootId]);
        let changed = true;
        while (changed) {
            changed = false;
            for (const item of features ?? []) {
                if (item.parentId && ids.has(item.parentId) && !ids.has(item.id)) {
                    ids.add(item.id);
                    changed = true;
                }
            }
        }
        return ids;
    }

    const scopeIds = descendantIds(feature.id);
    const scopedSpecs = specs.filter((spec) => scopeIds.has(spec.featureId));
    const counts = scopedSpecs.reduce<Record<SpecStatus, number>>(
        (acc, spec) => ({ ...acc, [spec.status]: acc[spec.status] + 1 }),
        { passed: 0, failed: 0, unverified: 0, invalid: 0, conflict: 0 },
    );

    async function handleRunAll() {
        if (!feature || scopedSpecs.length === 0 || running) return;
        setRunning(true);
        try {
            await startRunBatch(projectId, scopedSpecs.map((spec) => spec.id), `Run ${feature.title}`);
            setRetryKey((key) => key + 1);
        } catch {
            // batch errors surface via the tree fetch
        } finally {
            setRunning(false);
        }
    }

    async function confirmDelete() {
        if (!feature) return;
        setDeleting(true);
        setDeleteError("");
        try {
            await api<void>(`/features/${feature.id}`, { method: "DELETE" });
            router.push(`/p/${projectId}/specs`);
        } catch (err) {
            setDeleteError(err instanceof Error ? err.message : String(err));
            setDeleting(false);
        }
    }

    return (
        <div className="flex min-h-full flex-col bg-surface">
            <PageHeader
                title={feature.title}
                eyebrow={parentFeature ? parentFeature.title : "Feature"}
                actions={
                    <div className="flex items-center gap-2">
                        <FeatureEditDialog
                            feature={feature}
                            onSaved={() => setRetryKey((key) => key + 1)}
                            renderTrigger={(onClick) => (
                                <Button type="button" variant="outline" size="sm" onClick={onClick}>Edit</Button>
                            )}
                        />
                        <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            onClick={(event) => {
                                deleteTriggerRef.current = event.currentTarget;
                                setDeleteError("");
                                setDeleteOpen(true);
                            }}
                        >
                            <Trash2 size={13} /> Delete
                        </Button>
                    </div>
                }
            />
            <div className="mx-auto w-full max-w-[1040px] flex-1 px-5 py-8">
                <div className="mb-6 border-b border-line pb-4">
                    <p className="text-[0.625rem] text-ink-faint">
                        <Link href={`/p/${projectId}/specs`} className="hover:text-ink hover:underline">Specs</Link>
                        {parentFeature && (
                            <>
                                {" / "}
                                <Link href={`/p/${projectId}/features/${parentFeature.id}`} className="hover:text-ink hover:underline">{parentFeature.title}</Link>
                            </>
                        )}
                    </p>
                    <h2 className="mt-1 text-lg font-bold tracking-[-0.02em] text-ink">{feature.title}</h2>
                    {feature.description && <p className="mt-1.5 max-w-[70ch] text-xs leading-5 text-ink-soft">{feature.description}</p>}
                </div>

                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <StatTile label="Total Specs" value={scopedSpecs.length} />
                    <StatTile label="Passed" value={counts.passed} tone="success" />
                    <StatTile label="Failed" value={counts.failed} tone="danger" />
                    <StatTile label="Unverified" value={counts.unverified} tone="pending" />
                </div>

                {childFeatures.length > 0 && (
                    <section className="mt-4">
                        <p className="text-[0.625rem] font-bold tracking-[0.08em] text-ink-faint uppercase">Sub-features</p>
                        <div className="mt-2 grid gap-2 sm:grid-cols-2">
                            {childFeatures.map((child) => (
                                <Link
                                    key={child.id}
                                    href={`/p/${projectId}/features/${child.id}`}
                                    className="flex items-center gap-2 rounded-[9px] border border-line bg-surface p-3 text-xs font-semibold text-ink transition-colors hover:bg-surface-hover"
                                >
                                    <Folder size={14} className="shrink-0 text-ink-faint" />
                                    <span className="min-w-0 flex-1 truncate">{child.title}</span>
                                    <Badge variant="secondary" className="text-[0.5625rem] text-ink-faint">
                                        {specs.filter((spec) => descendantIds(child.id).has(spec.featureId)).length}
                                    </Badge>
                                </Link>
                            ))}
                        </div>
                    </section>
                )}

                <section className="mt-4 rounded-[13px] border border-line bg-surface p-4">
                    <div className="flex items-center justify-between">
                        <p className="text-[0.625rem] font-bold tracking-[0.08em] text-ink-faint uppercase">Specs</p>
                        <Button type="button" variant="ghost" size="sm" onClick={handleRunAll} disabled={running || scopedSpecs.length === 0}>
                            {running ? <LoaderCircle size={12} className="animate-spin motion-reduce:animate-none" /> : <Play size={12} />}
                            {running ? "Running..." : "Run all"}
                        </Button>
                    </div>
                    {directSpecs.length === 0 ? (
                        <p className="mt-3 text-xs text-ink-faint">No Specs directly in this feature yet.</p>
                    ) : (
                        <ul aria-label="Specs in this feature" className="mt-2 -mx-2.5 space-y-0.5">
                            {directSpecs.map((spec) => (
                                <li key={spec.id}>
                                    <Link
                                        href={`/p/${projectId}/specs/${spec.id}`}
                                        className="flex items-center justify-between gap-3 rounded-[9px] px-2.5 py-2.5 transition-colors hover:bg-surface-hover"
                                    >
                                        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink">{spec.title}</span>
                                        <StatusPill status={spec.status} />
                                    </Link>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>
            </div>

            <ConfirmDeleteDialog
                open={deleteOpen}
                title="Delete feature?"
                description={<>
                    <strong className="font-bold text-ink">{feature.title}</strong> will be removed{childFeatures.length ? ` with ${childFeatures.length} nested ${childFeatures.length === 1 ? "feature" : "features"}` : ""}. This also deletes {scopedSpecs.length} active {scopedSpecs.length === 1 ? "Spec" : "Specs"}, run history, and evidence inside it. Earlier file revisions remain in Git history.
                </>}
                confirmLabel="Delete feature"
                busy={deleting}
                error={deleteError}
                returnFocusRef={deleteTriggerRef}
                onCancel={() => {
                    setDeleteOpen(false);
                    setDeleteError("");
                }}
                onConfirm={() => void confirmDelete()}
            />
        </div>
    );
}
