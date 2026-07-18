"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import { Pie, PieChart } from "recharts";
import { Check, CircleDashed, Clock3, FileCheck2, RefreshCw, X } from "lucide-react";
import { LogoMark } from "@/components/LogoMark";
import { PageHeader } from "@/components/PageHeader";
import { StatusPill } from "@/components/StatusPill";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import type { Feature, SpecStatus, SpecSummary } from "@/lib/types";

const STATUS_ORDER: SpecStatus[] = ["passed", "failed", "unverified", "draft"];

const STATUS_CHART_CONFIG: ChartConfig = {
    passed: { label: "Passed", color: "var(--color-success)" },
    failed: { label: "Failed", color: "var(--color-danger)" },
    unverified: { label: "Unverified", color: "var(--color-pending)" },
    draft: { label: "Draft", color: "var(--color-ink-disabled)" },
};

const STATUS_ICON: Record<SpecStatus, React.ComponentType<{ size?: number; className?: string }>> = {
    passed: Check,
    failed: X,
    unverified: CircleDashed,
    draft: Clock3,
};

function StatTile({ label, value, tone }: { label: string; value: number; tone?: "success" | "danger" | "pending" }) {
    const toneClass = tone === "success" ? "text-success" : tone === "danger" ? "text-danger" : tone === "pending" ? "text-pending" : "text-ink";
    return (
        <div className="rounded-[13px] border border-line bg-surface p-4">
            <p className="text-[0.625rem] font-bold tracking-[0.08em] text-ink-faint uppercase">{label}</p>
            <p className={`mt-1.5 text-xl font-bold tracking-[-0.02em] tabular-nums ${toneClass}`}>{value}</p>
        </div>
    );
}

export default function SpecsDashboard({ params }: { params: Promise<{ projectId: string }> }) {
    const { projectId } = use(params);
    const [features, setFeatures] = useState<Feature[] | null>(null);
    const [specs, setSpecs] = useState<SpecSummary[] | null>(null);
    const [loadError, setLoadError] = useState("");
    const [retryKey, setRetryKey] = useState(0);

    useEffect(() => {
        let active = true;
        setLoadError("");
        api<{ features: Feature[]; specs: SpecSummary[] }>(`/projects/${projectId}/tree`)
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
    }, [projectId, retryKey]);

    if (loadError) {
        return (
            <div className="flex min-h-full flex-col bg-surface">
                <PageHeader title="Specs" eyebrow="Project" />
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
                <span className="sr-only">Loading Specs dashboard</span>
                <PageHeader title="Specs" eyebrow="Project" />
                <div className="mx-auto w-full max-w-[1040px] space-y-4 px-5 py-8">
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                        {Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-20 rounded-[13px]" />)}
                    </div>
                    <div className="grid gap-4 md:grid-cols-[280px_1fr]">
                        <Skeleton className="h-64 rounded-[13px]" />
                        <Skeleton className="h-64 rounded-[13px]" />
                    </div>
                </div>
            </div>
        );
    }

    if (specs.length === 0) {
        return (
            <div className="flex min-h-full flex-col bg-surface">
                <PageHeader title="Specs" eyebrow="Project" />
                <div className="flex flex-1 items-center justify-center px-5 py-10">
                    <div className="max-w-[420px] text-center">
                        <LogoMark className="mx-auto size-9" />
                        <h2 className="mt-4 text-sm font-bold">No Specs yet</h2>
                        <p className="mt-2 text-xs leading-5 text-ink-soft">
                            Describe a behavior in a chat and the agent will save it as a verified Spec here.
                        </p>
                        <Button asChild className="mt-5">
                            <Link href={`/p/${projectId}/chats/new`}>
                                <FileCheck2 size={13} /> Start a chat
                            </Link>
                        </Button>
                    </div>
                </div>
            </div>
        );
    }

    const featureById = new Map(features.map((feature) => [feature.id, feature]));
    const counts = STATUS_ORDER.reduce<Record<SpecStatus, number>>(
        (acc, status) => ({ ...acc, [status]: 0 }),
        { passed: 0, failed: 0, unverified: 0, draft: 0 },
    );
    for (const spec of specs) counts[spec.status] += 1;

    const chartData = STATUS_ORDER.filter((status) => counts[status] > 0).map((status) => ({
        status,
        count: counts[status],
        fill: `var(--color-${status})`,
    }));

    const listPriority: Record<SpecStatus, number> = { failed: 0, unverified: 1, draft: 2, passed: 3 };
    const orderedSpecs = [...specs].sort((a, b) => listPriority[a.status] - listPriority[b.status]);

    const passRate = specs.length > 0 ? Math.round((counts.passed / specs.length) * 100) : 0;
    const passRateTone = counts.failed > 0 ? "text-danger" : counts.unverified > 0 ? "text-pending" : "text-success";

    return (
        <div className="flex min-h-full flex-col bg-surface">
            <PageHeader title="Specs" eyebrow="Project" />
            <div className="mx-auto w-full max-w-[1040px] flex-1 px-5 py-8">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <StatTile label="Total Specs" value={specs.length} />
                    <StatTile label="Passed" value={counts.passed} tone="success" />
                    <StatTile label="Failed" value={counts.failed} tone="danger" />
                    <StatTile label="Unverified" value={counts.unverified} tone="pending" />
                </div>

                <div className="mt-4 grid gap-4 md:grid-cols-[280px_1fr] md:items-start">
                    <div className="rounded-[13px] border border-line bg-surface p-4">
                        <p className="text-[0.625rem] font-bold tracking-[0.08em] text-ink-faint uppercase">Status breakdown</p>
                        <p className="mt-1 text-xs text-ink-soft">
                            <span className={`font-bold ${passRateTone}`}>{passRate}%</span> of Specs are passing
                        </p>
                        <ChartContainer config={STATUS_CHART_CONFIG} className="mx-auto mt-3 aspect-square max-h-[170px]">
                            <PieChart>
                                <ChartTooltip content={<ChartTooltipContent nameKey="status" hideLabel />} />
                                <Pie data={chartData} dataKey="count" nameKey="status" innerRadius="55%" outerRadius="85%" strokeWidth={2} stroke="var(--color-surface)" />
                            </PieChart>
                        </ChartContainer>
                        {chartData.length > 1 && (
                            <ul className="mt-4 space-y-1.5 border-t border-line pt-3">
                                {STATUS_ORDER.filter((status) => counts[status] > 0).map((status) => {
                                    const Icon = STATUS_ICON[status];
                                    return (
                                        <li key={status} className="flex items-center justify-between gap-2 text-[0.6875rem]">
                                            <span className="flex items-center gap-1.5 text-ink-soft">
                                                <Icon size={11} className="text-ink-faint" />
                                                {STATUS_CHART_CONFIG[status].label}
                                            </span>
                                            <span className="font-bold text-ink">{counts[status]}</span>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </div>

                    <div className="rounded-[13px] border border-line bg-surface p-4">
                        <p className="text-[0.625rem] font-bold tracking-[0.08em] text-ink-faint uppercase">All Specs</p>
                        <ul className="mt-2 divide-y divide-line">
                            {orderedSpecs.map((spec) => {
                                const feature = featureById.get(spec.featureId);
                                return (
                                    <li key={spec.id}>
                                        <Link
                                            href={`/p/${projectId}/specs/${spec.id}`}
                                            className="flex items-center justify-between gap-3 py-2.5 hover:bg-surface-hover"
                                        >
                                            <span className="min-w-0 flex-1">
                                                <span className="block truncate text-xs font-semibold text-ink">{spec.title}</span>
                                                {feature && <span className="mt-0.5 block truncate text-[0.625rem] text-ink-faint">{feature.title}</span>}
                                            </span>
                                            <StatusPill status={spec.status} />
                                        </Link>
                                    </li>
                                );
                            })}
                        </ul>
                    </div>
                </div>
            </div>
        </div>
    );
}
