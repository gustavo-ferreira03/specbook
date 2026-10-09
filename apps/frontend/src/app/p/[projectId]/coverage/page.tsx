import { redirect } from "next/navigation";

export default async function CoverageRedirect({ params }: { params: Promise<{ projectId: string }> }) {
    const { projectId } = await params;
    redirect(`/p/${encodeURIComponent(projectId)}`);
}
