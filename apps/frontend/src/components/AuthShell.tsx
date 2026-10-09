import { Check, Target } from "lucide-react";
import { LogoMark } from "@/components/LogoMark";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Label } from "@/components/ui/label";

const SAMPLE_STEPS = [
    "Sign in as the standard user",
    "Add the backpack and the bike light to the cart",
    "Remove the backpack from the cart",
];

function SpecSheet() {
    return (
        <div className="w-full max-w-[420px]">
            <p className="font-mono text-meta text-primary-foreground/60">cart/removing-items/spec.yml</p>
            <h2 className="mt-3 text-title text-primary-foreground">Removing an item updates the cart badge</h2>
            <ol className="mt-8 space-y-3">
                {SAMPLE_STEPS.map((step, index) => (
                    <li key={step} className="flex items-start gap-3 text-body text-primary-foreground/85">
                        <span className="tabular flex size-6 shrink-0 items-center justify-center rounded-md border border-primary-foreground/25 text-meta">{index + 1}</span>
                        <span className="flex-1 pt-0.5">{step}</span>
                        <Check
                            size={15}
                            strokeWidth={2.5}
                            aria-hidden="true"
                            className="auth-step-check mt-1 shrink-0 text-primary-foreground"
                            style={{ animationDelay: `${600 + index * 520}ms` }}
                        />
                    </li>
                ))}
            </ol>
            <div className="mt-8 rounded-xl border border-primary-foreground/20 px-4 py-3.5">
                <p className="flex items-center gap-1.5 text-control font-semibold text-primary-foreground"><Target size={14} aria-hidden="true" /> Expected result</p>
                <p className="mt-1.5 text-body text-primary-foreground/85">The badge shows 1 and the bike light stays in the cart.</p>
            </div>
            <p className="tabular mt-6 flex items-center gap-2 text-meta text-primary-foreground/60">
                <Check size={13} strokeWidth={2.5} aria-hidden="true" /> Passed · 1.1s
            </p>
        </div>
    );
}

export function AuthShell({ title, description, children, footer }: { title: string; description: string; children: React.ReactNode; footer?: React.ReactNode }) {
    return (
        <main className="grid min-h-dvh bg-surface lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <section className="flex min-h-dvh flex-col px-6 py-6 sm:px-10">
                <header className="flex items-center justify-between">
                    <span className="flex items-center gap-2.5 text-section text-ink"><LogoMark className="size-7 dark:invert" /> Specbook</span>
                    <ThemeToggle />
                </header>
                <div className="mx-auto flex w-full max-w-[360px] flex-1 flex-col justify-center py-12">
                    <h1 className="text-title text-ink">{title}</h1>
                    <p className="mt-1.5 text-body text-ink-muted">{description}</p>
                    <div className="mt-8">{children}</div>
                    {footer && <div className="mt-8 border-t border-line pt-5 text-control text-ink-muted">{footer}</div>}
                </div>
            </section>
            <aside aria-hidden="true" className="hidden items-center justify-center bg-primary px-12 lg:flex">
                <SpecSheet />
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
