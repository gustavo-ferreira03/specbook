import { Sidebar } from "@/components/Sidebar";
import { ProjectOverviewProvider } from "@/lib/projectOverview";

export default async function ProjectLayout({ children, params }: { children: React.ReactNode; params: Promise<{ projectId: string }> }) {
    const { projectId } = await params;
    return (
        <ProjectOverviewProvider projectId={projectId}>
            <div className="flex h-dvh min-w-0 flex-col overflow-hidden md:flex-row">
                <a href="#main-content" className="skip-link">Skip to content</a>
                <Sidebar projectId={projectId} />
                <main id="main-content" tabIndex={-1} className="relative min-h-0 min-w-0 flex-1 overflow-y-auto bg-surface">{children}</main>
            </div>
        </ProjectOverviewProvider>
    );
}
