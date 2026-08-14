export function PageHeader({
    title,
    eyebrow,
    description,
    actions,
}: {
    title: string;
    eyebrow?: React.ReactNode;
    description?: React.ReactNode;
    actions?: React.ReactNode;
}) {
    return (
        <header className="flex min-h-16 shrink-0 items-center justify-between gap-4 border-b border-line bg-surface px-4 py-3 md:min-h-[72px] md:px-7">
            <div className="min-w-0">
                {eyebrow && (
                    <div className="mb-1 truncate text-[0.625rem] font-bold tracking-[0.08em] text-ink-faint uppercase">
                        {eyebrow}
                    </div>
                )}
                <h1 className="truncate text-base font-bold tracking-[-0.025em] text-ink text-balance md:text-[1.0625rem]">{title}</h1>
                {description && <p className="mt-1 max-w-[62ch] truncate text-[0.6875rem] leading-5 text-ink-soft">{description}</p>}
            </div>
            {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
    );
}
