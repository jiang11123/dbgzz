const workspaceRouteLoaders = {
    agents: () => import("@/pages/agents"),
    home: () => import("@/pages/home"),
    assets: () => import("@/pages/assets"),
    canvas: () => import("@/pages/canvas"),
    create: () => import("@/pages/create"),
    projects: () => import("@/pages/projects"),
    projectDetail: () => import("@/pages/projects/detail"),
};

export const loadAgentsPage = workspaceRouteLoaders.agents;
export const loadAssetsPage = workspaceRouteLoaders.assets;
export const loadHomePage = workspaceRouteLoaders.home;
export const loadCanvasPage = workspaceRouteLoaders.canvas;
export const loadCanvasProjectPage = () => import("@/pages/canvas/project");
export const loadCreatePage = workspaceRouteLoaders.create;
export const loadProjectDetailPage = workspaceRouteLoaders.projectDetail;
export const loadProjectsPage = workspaceRouteLoaders.projects;

export function preloadWorkspaceRoute(pathnameOrSlug: string) {
    const segments = pathnameOrSlug.replace(/^\//, "").split("/").filter(Boolean);
    const slug = segments[0] || "home";
    if (slug === "projects" && segments.length > 1) {
        void workspaceRouteLoaders.projectDetail();
        return;
    }
    const load = workspaceRouteLoaders[slug as keyof typeof workspaceRouteLoaders];
    if (load) void load();
}
