import { createFileRoute } from '@tanstack/react-router';

import { WorkspaceProjectRoutePage } from '@/components/app/workspace-project-route-page';
import { loadWorkspaceProjectRoute } from '@/core/projects/workspace-project-route-loader';

export const Route = createFileRoute('/story/$projectId')({
  ssr: 'data-only',
  validateSearch: (search: Record<string, unknown>) => ({
    story: (search.story as string) || undefined,
    scene: (search.scene as string) || undefined,
  }),
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ params, deps }) =>
    loadWorkspaceProjectRoute({
      projectId: params.projectId,
      search: deps.search,
      workspaceMode: 'story',
    }),
  component: StoryProjectRouteComponent,
});

function StoryProjectRouteComponent() {
  const data = Route.useLoaderData();
  return <WorkspaceProjectRoutePage data={data} />;
}