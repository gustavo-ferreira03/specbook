import Link from "next/link";
import { ArrowLeft, Settings } from "lucide-react";
import { LogoMark } from "@/components/LogoMark";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Button } from "@/components/ui/button";

export function InstanceHeader({ setup = false }: { setup?: boolean }) {
    return <header className="flex min-h-14 flex-wrap items-center justify-between gap-3 border-b border-line bg-surface px-4 py-2 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5 rounded-sm text-section text-ink"><LogoMark className="size-7 dark:invert" /> Specbook</Link>
        <div className="flex items-center gap-2">
            {!setup && <Button asChild variant="ghost" size="sm"><Link href="/"><ArrowLeft size={14} /> Projects</Link></Button>}
            {setup && <Button asChild variant="ghost" size="icon" aria-label="Instance settings"><Link href="/settings"><Settings size={16} /></Link></Button>}
            <ThemeToggle />
        </div>
    </header>;
}
