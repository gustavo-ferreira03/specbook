import { CircleHelp, ExternalLink } from "lucide-react";

import type { ProjectContext } from "@/lib/types";

const hostOf = function hostOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return url;
  }
};

const Section = function Section({
  title,
  count,
  icon,
  children,
}: {
  title: string;
  count?: number;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="border-line border-t pt-5">
      <h3 className="text-section text-ink mb-3 flex items-center gap-2">
        {icon}
        {title}
        {count !== undefined && (
          <span className="tabular text-meta text-ink-subtle font-normal">
            {count}
          </span>
        )}
      </h3>
      {children}
    </section>
  );
};

const Points = function Points({ items }: { items: string[] }) {
  return (
    <ul className="space-y-2">
      {items.map((item, index) => (
        <li key={index} className="text-body text-ink-muted flex gap-2.5">
          <span
            aria-hidden="true"
            className="bg-ink-subtle mt-[0.6em] size-1 shrink-0 rounded-full"
          />
          <span className="max-w-[68ch]">{item}</span>
        </li>
      ))}
    </ul>
  );
};

export const ContextReadout = function ContextReadout({
  context,
  renderAreaStatus,
  renderArea,
}: {
  context: ProjectContext;
  renderAreaStatus?: (name: string) => React.ReactNode;
  renderArea?: (name: string) => React.ReactNode;
}) {
  const lists = [
    { title: "Business rules", items: context.businessRules },
    { title: "UI patterns", items: context.uiPatterns },
    { title: "Execution notes", items: context.executionNotes },
  ].filter((list) => list.items.length > 0);
  return (
    <div className="space-y-8">
      <p className="text-ink max-w-[62ch] text-base leading-relaxed [text-wrap:pretty]">
        {context.summary}
      </p>

      {context.areas.length > 0 && (
        <Section title="Areas" count={context.areas.length}>
          <ul className="divide-line divide-y">
            {context.areas.map((area, index) => (
              <li key={index} className="py-4 first:pt-1">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <h4 className="text-body text-ink font-semibold">
                      {area.name}
                    </h4>
                    {renderAreaStatus?.(area.name)}
                  </div>
                  {area.description && (
                    <p className="text-body text-ink-muted mt-1 max-w-[68ch]">
                      {area.description}
                    </p>
                  )}
                  {area.routes.length > 0 && (
                    <p className="text-meta text-ink-subtle mt-1 font-mono [overflow-wrap:anywhere]">
                      {area.routes.join("  ·  ")}
                    </p>
                  )}
                </div>
                {renderArea?.(area.name)}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {context.terminology.length > 0 && (
        <Section title="Terminology" count={context.terminology.length}>
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-[minmax(8rem,12rem)_minmax(0,1fr)]">
            {context.terminology.map((item, index) => (
              <div key={index} className="contents">
                <dt className="text-body text-ink font-semibold [overflow-wrap:anywhere]">
                  {item.term}
                </dt>
                <dd className="text-body text-ink-muted">{item.meaning}</dd>
              </div>
            ))}
          </dl>
        </Section>
      )}

      {context.roles.length > 0 && (
        <Section title="Roles" count={context.roles.length}>
          <ul className="grid gap-x-8 gap-y-5 md:grid-cols-2">
            {context.roles.map((role, index) => (
              <li key={index}>
                <p className="text-body text-ink font-semibold">{role.name}</p>
                {role.capabilities.length > 0 && (
                  <div className="mt-1.5">
                    <Points items={role.capabilities} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {lists.map((list) => (
        <Section key={list.title} title={list.title} count={list.items.length}>
          <Points items={list.items} />
        </Section>
      ))}

      {context.unknowns.length > 0 && (
        <Section
          title="Open questions"
          count={context.unknowns.length}
          icon={
            <CircleHelp
              size={15}
              className="text-warning-icon"
              aria-hidden="true"
            />
          }
        >
          <p className="text-meta text-ink-muted -mt-1 mb-3">
            What discovery could not confirm. Answer these in a chat to sharpen
            the context.
          </p>
          <Points items={context.unknowns} />
        </Section>
      )}

      {context.sources.length > 0 && (
        <details className="group border-line border-t pt-5">
          <summary className="text-section text-ink flex cursor-pointer list-none items-baseline gap-2 [&::-webkit-details-marker]:hidden">
            Sources{" "}
            <span className="tabular text-meta text-ink-subtle font-normal">
              {context.sources.length}
            </span>
            <span className="text-meta text-ink-subtle font-normal group-open:hidden">
              Show
            </span>
            <span className="text-meta text-ink-subtle hidden font-normal group-open:inline">
              Hide
            </span>
          </summary>
          <ul className="mt-3 space-y-2">
            {context.sources.map((source, index) => (
              <li key={index} className="text-body text-ink-muted">
                <a
                  href={source.url}
                  target="_blank"
                  rel="noreferrer"
                  className="link-bold text-meta text-ink inline-flex items-center gap-1 font-mono [overflow-wrap:anywhere]"
                >
                  {hostOf(source.url)}{" "}
                  <ExternalLink size={11} aria-hidden="true" />
                </a>
                {source.note && <p className="mt-0.5">{source.note}</p>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
};
