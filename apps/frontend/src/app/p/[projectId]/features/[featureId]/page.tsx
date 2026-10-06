"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useEffect, useMemo, useRef, useState } from "react";
import { FolderX, PencilLine, RefreshCw, Trash2 } from "lucide-react";
import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { EmptyState } from "@/components/EmptyState";
import { FeatureEditDialog } from "@/components/FeatureEditDialog";
import { FeatureFileDialog } from "@/components/FeatureFileDialog";
import { PageContainer, PageHeader, type Crumb } from "@/components/PageHeader";
import { SpecRunDialog } from "@/components/SpecRunDialog";
import { SummaryStrip } from "@/components/SummaryStrip";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { deleteFeature, errorMessage, getProjectTree, isAbortError } from "@/lib/api";
import { matchesInvalidation, onInvalidate } from "@/lib/invalidation";
import { countStatuses } from "@/lib/status";
import { useRunBatch } from "@/lib/useRunBatch";
import type { Feature, SpecSummary } from "@/lib/types";
import { RunningIcon, SpecTable, SpecTableSkeleton, orderFeatures, lastRunsOf, type SpecGroup } from "../../specs/_components/spec-table";

function isRunnable(spec: SpecSummary) {
    return spec.status !== "invalid";
}

export default function FeaturePage({ params }: { params: Promise<{ projectId: string; featureId: string }> }) {
    const { projectId, featureId } = use(params);
    const router = useRouter();
    const [features, setFeatures] = useState<Feature[] | null>(null);
    const [specs, setSpecs] = useState<SpecSummary[] | null>(null);
    const [loadError, setLoadError] = useState("");
    const [retryKey, setRetryKey] = useState(0);
    const runBatch = useRunBatch(projectId);
    const running = runBatch.running;
    const [deleteOpen, setDeleteOpen] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [deleteError, setDeleteError] = useState("");
    const deleteTriggerRef = useRef<HTMLElement | null>(null);

    useEffect(() => {
        const controller = new AbortController();
        setLoadError("");
        getProjectTree(projectId, controller.signal)
            .then((result) => {
                setFeatures(result.features);
                setSpecs(result.specs);
            })
            .catch((error) => {
                if (isAbortError(error)) return;
                setLoadError(errorMessage(error));
            });
        return () => controller.abort();
    }, [projectId, featureId, retryKey]);

    useEffect(() => onInvalidate((event) => {
        if (deleting) return;
        if (matchesInvalidation(event, "tree", projectId)) setRetryKey((key) => key + 1);
    }), [deleting, projectId]);

    const feature = features?.find((item) => item.id === featureId) ?? null;
    const descendants = useMemo(() => (features && feature ? orderFeatures(features, feature.id) : []), [feature, features]);
    const scopedSpecs = useMemo(() => {
        if (!specs || !feature) return [];
        const scope = new Set([feature.id, ...descendants.map((item) => item.feature.id)]);
        return specs.filter((spec) => scope.has(spec.featureId));
    }, [descendants, feature, specs]);
    const lastRuns = useMemo(() => lastRunsOf(scopedSpecs), [scopedSpecs]);

    const specsCrumb: Crumb = { label: "Specs", href: `/p/${projectId}/specs` };

    if (loadError) {
        return (
            <div className="flex min-h-full flex-col bg-surface">
                <PageHeader title="Feature" breadcrumbs={[specsCrumb]} width="data" />
                <EmptyState
                    role="alert"
                    tone="danger"
                    icon={FolderX}
                    title="This feature could not load"
                    description={loadError}
                    action={<Button type="button" onClick={() => setRetryKey((key) => key + 1)}><RefreshCw size={14} /> Try again</Button>}
                />
            </div>
        );
    }

    if (!features || !specs) {
        return (
            <div className="flex min-h-full flex-col bg-surface" aria-busy="true" role="status">
                <span className="sr-only">Loading feature</span>
                <PageHeader title={<Skeleton className="h-6 w-56" />} breadcrumbs={[specsCrumb]} width="data" />
                <PageContainer width="data" innerClassName="space-y-6">
                    <div className="space-y-3"><Skeleton className="h-4 w-72 max-w-full" /><Skeleton className="h-1.5 w-full rounded-full" /></div>
                    <SpecTableSkeleton groups={1} rows={4} />
                </PageContainer>
            </div>
        );
    }

    if (!feature) {
        return (
            <div className="flex min-h-full flex-col bg-surface">
                <PageHeader title="Feature not found" breadcrumbs={[specsCrumb]} width="data" />
                <EmptyState
                    icon={FolderX}
                    title="This feature no longer exists"
                    description="It may have been deleted or renamed in the repository."
                    action={<Button asChild><Link href={`/p/${projectId}/specs`}>Back to Specs</Link></Button>}
                />
            </div>
        );
    }

    // Ancestors, root first, for the breadcrumb.
    const ancestors: Feature[] = [];
    const byId = new Map(features.map((item) => [item.id, item]));
    for (let parent = feature.parentId ? byId.get(feature.parentId) : undefined; parent && ancestors.length < 32; parent = parent.parentId ? byId.get(parent.parentId) : undefined) {
        ancestors.unshift(parent);
    }
    const crumbs: Crumb[] = [specsCrumb, ...ancestors.map((item) => ({ label: item.title, href: `/p/${projectId}/features/${item.id}` }))];

    const directSpecs = specs.filter((spec) => spec.featureId === feature.id);
    const childCount = features.filter((item) => item.parentId === feature.id).length;
    const groups: SpecGroup[] = [
        ...(directSpecs.length > 0
            ? [{ id: feature.id, title: descendants.length > 0 ? `${feature.title} (direct)` : feature.title, specs: directSpecs, hideHeader: descendants.length === 0 }]
            : []),
        ...descendants.map(({ feature: child, label }) => ({
            id: child.id,
            title: label,
            href: `/p/${projectId}/features/${child.id}`,
            specs: specs.filter((spec) => spec.featureId === child.id),
            emptyText: "No Specs in this feature yet.",
        })),
    ];
    const runnable = scopedSpecs.filter(isRunnable);

    function runSpecs(selected: SpecSummary[], label: string) {
        const targets = selected.filter(isRunnable);
        if (targets.length === 0) return;
        void runBatch.start(label, targets.map((spec) => ({ id: spec.id, title: spec.title })));
    }

    async function confirmDelete() {
        if (!feature) return;
        setDeleting(true);
        setDeleteError("");
        try {
            await deleteFeature(feature.id);
            router.push(`/p/${projectId}/specs`);
        } catch (err) {
            setDeleteError(errorMessage(err));
            setDeleting(false);
        }
    }

    return (
        <div className="flex min-h-full flex-col bg-surface">
            <PageHeader
                title={feature.title}
                breadcrumbs={crumbs}
                width="data"
                description={feature.description || undefined}
                meta={
                    <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                        <span className="font-mono [overflow-wrap:anywhere]">{feature.path}</span>
                        <span aria-hidden="true" className="text-ink-disabled">·</span>
                        <FeatureFileDialog
                            featureId={feature.id}
                            featureTitle={feature.title}
                            onSaved={() => setRetryKey((key) => key + 1)}
                            renderTrigger={(onClick) => (
                                <button type="button" onClick={onClick} className="rounded-sm underline-offset-2 outline-none hover:text-ink hover:underline focus-visible:ring-2 focus-visible:ring-ring">
                                    Edit source file
                                </button>
                            )}
                        />
                    </span>
                }
                actions={
                    <>
                        <FeatureEditDialog
                            feature={feature}
                            onSaved={() => setRetryKey((key) => key + 1)}
                            renderTrigger={(onClick) => (
                                <Button type="button" variant="outline" size="sm" onClick={onClick}><PencilLine size={13} /> Edit</Button>
                            )}
                        />
                        <Button type="button" size="sm" onClick={() => runSpecs(scopedSpecs, `Run ${feature.title}`)} disabled={running || runnable.length === 0}>
                            <RunningIcon running={running} /> {running ? "Running..." : "Run all"}
                        </Button>
                        <Button
                            type="button"
                            variant="destructive-soft"
                            size="sm"
                            onClick={(event) => {
                                deleteTriggerRef.current = event.currentTarget;
                                setDeleteError("");
                                setDeleteOpen(true);
                            }}
                        >
                            <Trash2 size={13} /> Delete
                        </Button>
                    </>
                }
            />
            <PageContainer width="data" innerClassName="space-y-6">
                {groups.length === 0 ? (
                    <div className="rounded-xl border border-line">
                        <EmptyState
                            icon={FolderX}
                            title="No Specs in this feature yet"
                            description="Describe a behavior in a chat, or create a Spec by hand from the Specs page."
                            action={<Button asChild variant="outline" size="sm"><Link href={`/p/${projectId}/chats/new`}>Start a chat</Link></Button>}
                        />
                    </div>
                ) : (
                    <>
                        <SummaryStrip
                            counts={countStatuses(scopedSpecs)}
                            trailing={childCount > 0 ? <span className="text-meta text-ink-subtle">Includes {childCount} {childCount === 1 ? "sub-feature" : "sub-features"}</span> : undefined}
                        />
                        <SpecTable
                            projectId={projectId}
                            label={`Specs in ${feature.title}`}
                            groups={groups}
                            lastRuns={lastRuns}
                            running={running}
                            onRunSpec={(spec) => runSpecs([spec], `Run ${spec.title}`)}
                            onRunGroup={(group) => runSpecs(group.specs, `Run ${typeof group.title === "string" ? group.title : feature.title}`)}
                        />
                    </>
                )}
            </PageContainer>

            <ConfirmDeleteDialog
                open={deleteOpen}
                title="Delete feature?"
                description={<>
                    <strong className="font-semibold text-ink">{feature.title}</strong> will be removed{childCount ? ` with ${childCount} nested ${childCount === 1 ? "feature" : "features"}` : ""}. This also deletes {scopedSpecs.length} active {scopedSpecs.length === 1 ? "Spec" : "Specs"}, run history, and evidence inside it. Earlier file revisions remain in Git history.
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
            <SpecRunDialog
                open={runBatch.open}
                onOpenChange={runBatch.setOpen}
                title={runBatch.title}
                items={runBatch.items}
                running={runBatch.running}
                reportUrl={runBatch.reportUrl}
                error={runBatch.error}
                warning={runBatch.warning}
            />
        </div>
    );
}
