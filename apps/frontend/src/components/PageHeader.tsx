export function PageHeader({
    title,
    eyebrow,
    actions,
}: {
    title: string;
    eyebrow?: React.ReactNode;
    actions?: React.ReactNode;
}) {
    return (
        <header className="flex h-16 shrink-0 items-center justify-between gap-4 border-b border-line bg-surface px-4 md:h-[72px] md:px-6">
            <div className="min-w-0">
                {eyebrow && (
                    <div className="mb-1 truncate text-[0.625rem] font-bold tracking-[0.08em] text-ink-faint uppercase">
                        {eyebrow}
                    </div>
                )}
                <h1 className="truncate text-[0.9375rem] font-bold tracking-[-0.012em] text-ink">{title}</h1>
            </div>
            {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
    );
}
