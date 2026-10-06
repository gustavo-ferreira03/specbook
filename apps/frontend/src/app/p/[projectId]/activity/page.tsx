import { OverviewRedirect } from "@/components/OverviewRedirect";

export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
    const { projectId } = await params;
    return <OverviewRedirect projectId={projectId} />;
}
