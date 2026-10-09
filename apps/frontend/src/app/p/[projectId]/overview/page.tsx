import { redirect } from "next/navigation";

export default async function OverviewRedirect({ params }: { params: Promise<{ projectId: string }> }) {
    const { projectId } = await params;
    redirect(`/p/${encodeURIComponent(projectId)}`);
}
