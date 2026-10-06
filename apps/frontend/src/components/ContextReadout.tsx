import type { ProjectContext } from "@/lib/types";

export function ContextReadout({ context, renderArea }: { context: ProjectContext; renderArea?: (name: string) => React.ReactNode }) {
    const lists: { title: string; items: string[] }[] = [
        { title: "Business rules", items: context.businessRules },
        { title: "UI patterns", items: context.uiPatterns },
        { title: "Execution notes", items: context.executionNotes },
        { title: "Unknowns", items: context.unknowns },
    ];
    return (
        <div className="space-y-6 text-control">
            <p className="max-w-[70ch] text-body text-ink">{context.summary}</p>
            {context.areas.length > 0 && (
                <div>
                    <h4 className="eyebrow mb-2 text-ink-subtle">Areas</h4>
                    <div className="grid items-start gap-2 sm:grid-cols-2">
                        {context.areas.map((area, index) => (
                            <div key={index} className="rounded-lg border border-line bg-surface-soft p-3">
                                <p className="font-semibold text-ink">{area.name}</p>
                                {area.routes.length > 0 && (
                                    <p className="mt-0.5 font-mono text-meta text-ink-subtle [overflow-wrap:anywhere]">{area.routes.join("  ·  ")}</p>
                                )}
                                {area.description && <p className="mt-1 text-ink-muted">{area.description}</p>}
                                {renderArea?.(area.name)}
                            </div>
                        ))}
                    </div>
                </div>
            )}
            {context.terminology.length > 0 && (
                <div>
                    <h4 className="eyebrow mb-2 text-ink-subtle">Terminology</h4>
                    <dl className="space-y-1">
                        {context.terminology.map((item, index) => (
                            <div key={index} className="flex flex-wrap gap-x-2">
                                <dt className="font-semibold text-ink">{item.term}</dt>
                                <dd className="text-ink-muted">{item.meaning}</dd>
                            </div>
                        ))}
                    </dl>
                </div>
            )}
            {context.roles.length > 0 && (
                <div>
                    <h4 className="eyebrow mb-2 text-ink-subtle">Roles</h4>
                    <ul className="space-y-1">
                        {context.roles.map((role, index) => (
                            <li key={index}>
                                <span className="font-semibold text-ink">{role.name}</span>
                                {role.capabilities.length > 0 && <span className="text-ink-muted">: {role.capabilities.join(", ")}</span>}
                            </li>
                        ))}
                    </ul>
                </div>
            )}
            {lists.some((list) => list.items.length > 0) && (
                <div className="grid items-start gap-x-6 gap-y-5 sm:grid-cols-2">
                    {lists.map(
                        (list) =>
                            list.items.length > 0 && (
                                <div key={list.title}>
                                    <h4 className="eyebrow mb-2 text-ink-subtle">{list.title}</h4>
                                    <ul className="list-disc space-y-1 pl-4 text-ink-muted marker:text-ink-subtle">
                                        {list.items.map((item, index) => (
                                            <li key={index}>{item}</li>
                                        ))}
                                    </ul>
                                </div>
                            ),
                    )}
                </div>
            )}
            {context.sources.length > 0 && (
                <div>
                    <h4 className="eyebrow mb-2 text-ink-subtle">Sources</h4>
                    <ul className="space-y-1 text-ink-muted">
                        {context.sources.map((source, index) => (
                            <li key={index} className="[overflow-wrap:anywhere]">
                                <span className="font-mono text-meta">{source.url}</span>
                                {source.note && <span> · {source.note}</span>}
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
}
