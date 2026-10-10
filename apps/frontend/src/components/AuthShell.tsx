import { AuthSpecReel } from "@/components/AuthSpecReel";
import { Brand } from "@/components/LogoMark";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Label } from "@/components/ui/label";
import { SpecGrid } from "@/components/SpecGrid";

export function AuthShell({ title, description, children, footer }: { title: string; description?: string; children: React.ReactNode; footer?: React.ReactNode }) {
    return (
        <main className="grid min-h-dvh bg-surface lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <section className="relative isolate flex min-h-dvh flex-col overflow-hidden px-6 py-6 sm:px-10">
                <SpecGrid className="-z-10" />
                <header className="flex items-center justify-end">
                    <ThemeToggle />
                </header>
                <div className="mx-auto flex w-full max-w-[420px] flex-1 flex-col justify-center py-12">
                    <div className="raised-panel rounded-xl bg-surface p-6 sm:p-8">
                        <div className="flex justify-center"><Brand large /></div>
                        <h1 className="mt-7 text-title text-ink">{title}</h1>
                        {description && <p className="mt-1.5 text-body text-ink-muted">{description}</p>}
                        <div className="mt-8">{children}</div>
                        {footer && <div className="mt-8 border-t border-line pt-5 text-control text-ink-muted">{footer}</div>}
                    </div>
                </div>
            </section>
            <aside aria-hidden="true" className="auth-panel relative isolate hidden items-center justify-center overflow-hidden bg-(--panel-bg) px-12 lg:flex">
                <SpecGrid className="spec-grid-inverse -z-10" />
                <AuthSpecReel />
            </aside>
        </main>
    );
}

export function AuthField({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
    return (
        <div className="space-y-1.5">
            <Label htmlFor={id} className="text-control font-medium text-ink">{label}</Label>
            {children}
            {hint && <p id={`${id}-hint`} className="text-meta text-ink-muted">{hint}</p>}
        </div>
    );
}
