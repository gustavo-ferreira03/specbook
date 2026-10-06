import { redirect } from "next/navigation";

/** Coverage is shown per area on the App page; old Coverage links land there. */
export default async function CoverageRedirect({ params }: { params: Promise<{ projectId: string }> }) {
    const { projectId } = await params;
    redirect(`/p/${encodeURIComponent(projectId)}`);
}
