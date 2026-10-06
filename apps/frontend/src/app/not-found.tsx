import Link from "next/link";
import { Search } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";

export default function NotFound() {
    return <main className="min-h-dvh bg-surface px-4 py-12"><EmptyState icon={Search} title="Page not found" description="This address does not point to a Specbook page. Return to your projects to continue." action={<Button asChild><Link href="/">Return to projects</Link></Button>} /></main>;
}
