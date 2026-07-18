import type { ProjectContext } from "@/lib/types";

export function ContextReadout({ context }: { context: ProjectContext }) {
    const lists: { title: string; items: string[] }[] = [
        { title: "Business rules", items: context.businessRules },
        { title: "UI patterns", items: context.uiPatterns },
        { title: "Execution notes", items: context.executionNotes },
        { title: "Unknowns", items: context.unknowns },
    ];
    return (
        <div className="space-y-5 text-xs leading-5">
            <p className="max-w-[70ch] text-ink-soft">{context.summary}</p>
            {context.areas.length > 0 && (
                <div>
                    <h4 className="mb-2 font-bold">Areas</h4>
                    <div className="grid items-start gap-2 sm:grid-cols-2">
                        {context.areas.map((area, index) => (
                            <div key={index} className="rounded-md border border-line bg-canvas p-3">
                                <p className="font-bold">{area.name}</p>
                                {area.routes.length > 0 && (
                                    <p className="mt-0.5 font-mono text-[0.65625rem] text-ink-faint [overflow-wrap:anywhere]">{area.routes.join("  ·  ")}</p>
                                )}
                                {area.description && <p className="mt-1 text-ink-soft">{area.description}</p>}
                            </div>
                        ))}
                    </div>
                </div>
            )}
            {context.terminology.length > 0 && (
                <div>
                    <h4 className="mb-2 font-bold">Terminology</h4>
                    <dl className="space-y-1">
                        {context.terminology.map((item, index) => (
                            <div key={index} className="flex flex-wrap gap-x-2">
                                <dt className="font-bold">{item.term}</dt>
                                <dd className="text-ink-soft">{item.meaning}</dd>
                            </div>
                        ))}
                    </dl>
                </div>
            )}
            {context.roles.length > 0 && (
                <div>
                    <h4 className="mb-2 font-bold">Roles</h4>
                    <ul className="space-y-1">
                        {context.roles.map((role, index) => (
                            <li key={index}>
                                <span className="font-bold">{role.name}</span>
                                {role.capabilities.length > 0 && <span className="text-ink-soft">: {role.capabilities.join(", ")}</span>}
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
                                    <h4 className="mb-2 font-bold">{list.title}</h4>
                                    <ul className="list-disc space-y-1 pl-4 text-ink-soft">
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
                    <h4 className="mb-2 font-bold">Sources</h4>
                    <ul className="space-y-1 text-ink-soft">
                        {context.sources.map((source, index) => (
                            <li key={index} className="[overflow-wrap:anywhere]">
                                <span className="font-mono text-[0.65625rem]">{source.url}</span>
                                {source.note && <span> · {source.note}</span>}
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
}
