import { redirect } from "next/navigation";

export default async function FeatureRedirect({ params }: { params: Promise<{ projectId: string; featureId: string }> }) {
    const { projectId, featureId } = await params;
    redirect(`/p/${encodeURIComponent(projectId)}/specs#feature-${encodeURIComponent(featureId)}`);
}
