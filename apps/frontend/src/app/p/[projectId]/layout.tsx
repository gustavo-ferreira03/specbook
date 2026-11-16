import { Sidebar } from "@/components/sidebar";
import { ProjectOverviewProvider } from "@/lib/project-overview";

const ProjectLayout = async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return (
    <ProjectOverviewProvider projectId={projectId}>
      <div className="flex h-dvh min-w-0 flex-col overflow-hidden md:flex-row">
        <a href="#main-content" className="skip-link">
          Skip to content
        </a>
        <Sidebar projectId={projectId} />
        <main
          id="main-content"
          tabIndex={-1}
          className="bg-surface relative min-h-0 min-w-0 flex-1 overflow-y-auto"
        >
          {children}
        </main>
      </div>
    </ProjectOverviewProvider>
  );
};
export default ProjectLayout;
