import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
    return <main className="min-h-dvh bg-surface px-4 py-8" role="status" aria-label="Loading page" aria-busy="true"><div className="mx-auto max-w-reading space-y-6"><Skeleton className="h-7 w-48" /><Skeleton className="h-4 w-64" /><Skeleton className="h-40 w-full" /></div></main>;
}
