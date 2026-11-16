import { AuthSpecReel } from "@/components/auth-spec-reel";
import { Brand } from "@/components/logo-mark";
import { SpecGrid } from "@/components/spec-grid";
import { ThemeToggle } from "@/components/theme-toggle";
import { Label } from "@/components/ui/label";

export const AuthShell = function AuthShell({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <main className="bg-surface grid min-h-dvh lg:grid-cols-[minmax(0,13fr)_minmax(0,7fr)]">
      <section className="relative isolate flex min-h-dvh flex-col overflow-hidden px-6 py-6 sm:px-10">
        <SpecGrid className="-z-10" />
        <header className="flex items-center justify-end">
          <ThemeToggle />
        </header>
        <div className="mx-auto flex w-full max-w-[480px] flex-1 flex-col justify-center py-12">
          <div className="raised-panel bg-surface rounded-xl p-7 sm:p-10">
            <div className="flex justify-center">
              <Brand large />
            </div>
            <h1 className="text-ink mt-8 text-[1.875rem] leading-tight font-semibold tracking-[-0.025em]">
              {title}
            </h1>
            {description && (
              <p className="text-ink-muted mt-2 text-base">{description}</p>
            )}
            <div className="auth-form mt-8">{children}</div>
            {footer && (
              <div className="border-line text-ink-muted mt-8 border-t pt-6 text-[0.9375rem]">
                {footer}
              </div>
            )}
          </div>
        </div>
      </section>
      <aside
        aria-hidden="true"
        className="auth-panel relative isolate hidden items-center justify-center overflow-hidden bg-(--panel-bg) px-12 lg:order-first lg:flex"
      >
        <SpecGrid className="spec-grid-inverse -z-10" />
        <AuthSpecReel />
      </aside>
    </main>
  );
};

export const AuthField = function AuthField({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-ink text-[0.9375rem] font-medium">
        {label}
      </Label>
      {children}
      {hint && (
        <p id={`${id}-hint`} className="text-ink-muted text-sm">
          {hint}
        </p>
      )}
    </div>
  );
};
