import { redirect } from "next/navigation";

/** Features are groups on the Specs page; old Feature links land on their group. */
export default async function FeatureRedirect({ params }: { params: Promise<{ projectId: string; featureId: string }> }) {
    const { projectId, featureId } = await params;
    redirect(`/p/${encodeURIComponent(projectId)}/specs#feature-${encodeURIComponent(featureId)}`);
}
