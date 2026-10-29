import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { useCanvasStore, withCanvasStorePersistenceSuppressed } from "@/stores/canvas/use-canvas-store";

const workspaceProject = await import("@/lib/canvas/canvas-workspace-project").catch(() => ({}));

type CanvasRecord = {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    workspaceProjectId?: string;
};

const canvas = (id: string, createdAt: string, workspaceProjectId?: string): CanvasRecord => ({
    id,
    title: id,
    createdAt,
    updatedAt: createdAt,
    workspaceProjectId,
});

describe("canvas workspace project grouping", () => {
    test("treats every legacy canvas as its own project", () => {
        expect(typeof workspaceProject.canvasWorkspaceProjectId).toBe("function");
        expect(typeof workspaceProject.listCanvasWorkspaceProjectRoots).toBe("function");
        if (!("canvasWorkspaceProjectId" in workspaceProject) || !("listCanvasWorkspaceProjectRoots" in workspaceProject)) return;
        const legacyA = canvas("legacy-a", "2026-01-01T00:00:00.000Z");
        const legacyB = canvas("legacy-b", "2026-01-02T00:00:00.000Z");

        expect(workspaceProject.canvasWorkspaceProjectId(legacyA)).toBe("legacy-a");
        expect(workspaceProject.listCanvasWorkspaceProjectRoots([legacyA, legacyB]).map((item) => item.id)).toEqual(["legacy-a", "legacy-b"]);
    });

    test("lists only canvases belonging to the current project in stable creation order", () => {
        expect(typeof workspaceProject.listCanvasWorkspaceProjectCanvases).toBe("function");
        expect(typeof workspaceProject.listCanvasWorkspaceProjectRoots).toBe("function");
        if (!("listCanvasWorkspaceProjectCanvases" in workspaceProject) || !("listCanvasWorkspaceProjectRoots" in workspaceProject)) return;
        const root = canvas("project-a", "2026-01-01T00:00:00.000Z", "project-a");
        const second = canvas("canvas-a2", "2026-01-02T00:00:00.000Z", "project-a");
        const other = canvas("project-b", "2026-01-03T00:00:00.000Z", "project-b");

        expect(workspaceProject.listCanvasWorkspaceProjectCanvases([second, other, root], second.id).map((item) => item.id)).toEqual(["project-a", "canvas-a2"]);
        expect(workspaceProject.listCanvasWorkspaceProjectRoots([second, other, root]).map((item) => item.id)).toEqual(["project-a", "project-b"]);
    });

    test("expands selected project roots to all of their canvas ids", () => {
        expect(typeof workspaceProject.canvasIdsForWorkspaceProjects).toBe("function");
        if (!("canvasIdsForWorkspaceProjects" in workspaceProject)) return;
        const root = canvas("project-a", "2026-01-01T00:00:00.000Z", "project-a");
        const second = canvas("canvas-a2", "2026-01-02T00:00:00.000Z", "project-a");
        const other = canvas("project-b", "2026-01-03T00:00:00.000Z", "project-b");

        expect(workspaceProject.canvasIdsForWorkspaceProjects([root, second, other], [root.id])).toEqual(["project-a", "canvas-a2"]);
    });

    test("creates a root canvas for a new project and lets child canvases inherit that project", () => {
        const previousProjects = useCanvasStore.getState().projects;
        try {
            let rootId = "";
            let childId = "";
            withCanvasStorePersistenceSuppressed(() => {
                useCanvasStore.setState({ projects: [] });
                const createProject = useCanvasStore.getState().createProject as (title?: string, projectId?: string, workspaceProjectId?: string) => string;
                rootId = createProject("测试项目");
                childId = createProject("未命名画布", undefined, rootId);
            });
            const created = useCanvasStore.getState().projects;
            expect(created.find((item) => item.id === rootId)?.workspaceProjectId).toBe(rootId);
            expect(created.find((item) => item.id === childId)?.workspaceProjectId).toBe(rootId);
        } finally {
            withCanvasStorePersistenceSuppressed(() => useCanvasStore.setState({ projects: previousProjects }));
        }
    });

    test("wires the editor menu and project library through the project boundary", () => {
        const editor = readFileSync(new URL("../src/pages/canvas/project.tsx", import.meta.url), "utf8");
        const lifecycle = readFileSync(new URL("../src/pages/canvas/use-canvas-project-lifecycle.ts", import.meta.url), "utf8");
        const library = readFileSync(new URL("../src/pages/canvas/index.tsx", import.meta.url), "utf8");

        expect(editor).toContain("listCanvasWorkspaceProjectCanvases(storedCanvasProjects, projectId)");
        expect(lifecycle).toContain("canvasWorkspaceProjectId(currentProject)");
        expect(library).toContain("listCanvasWorkspaceProjectRoots(localProjects)");
        expect(library).toContain("canvasIdsForWorkspaceProjects(localProjects, selectedIds)");
    });

    test("keeps the workspace title stable while switching between child canvases", () => {
        const editor = readFileSync(new URL("../src/pages/canvas/project.tsx", import.meta.url), "utf8");
        const lifecycle = readFileSync(new URL("../src/pages/canvas/use-canvas-project-lifecycle.ts", import.meta.url), "utf8");

        expect(editor).toContain("const workspaceProject = workspaceCanvases[0] || null");
        expect(editor).toContain('title={workspaceProject?.title === "未命名项目" || !workspaceProject?.title ? "未命名工作区" : workspaceProject.title}');
        expect(editor).toContain('setTitleDraft(workspaceProject?.title || "未命名工作区")');
        expect(lifecycle).toContain("renameProject(canvasWorkspaceProjectId(currentProject), title)");
    });

    test("duplicates the selected canvas name and complete content inside the same workspace project", () => {
        const previousProjects = useCanvasStore.getState().projects;
        try {
            let rootId = "";
            let copyId = "";
            withCanvasStorePersistenceSuppressed(() => {
                useCanvasStore.setState({ projects: [] });
                rootId = useCanvasStore.getState().createProject("画布 1");
                useCanvasStore.getState().updateProject(rootId, {
                    canvasTitle: "分镜画布",
                    nodes: [{ id: "node-1", type: "text", x: 40, y: 80, width: 320, height: 180, content: "原画布节点" }] as never,
                    connections: [{ id: "connection-1", sourceNodeId: "node-1", targetNodeId: "node-2" }] as never,
                    viewport: { x: 120, y: -40, k: 1.25 },
                    timeline: { id: "timeline-1", tracks: [] } as never,
                });
                const root = useCanvasStore.getState().openProject(rootId)!;
                copyId = useCanvasStore.getState().importProject({ ...root, canvasTitle: "分镜画布 副本" }, rootId);
            });

            const projectCanvases = workspaceProject.listCanvasWorkspaceProjectCanvases?.(useCanvasStore.getState().projects, copyId) || [];
            const root = projectCanvases.find((item) => item.id === rootId);
            const copy = projectCanvases.find((item) => item.id === copyId);
            expect(projectCanvases.map((item) => item.id)).toEqual([rootId, copyId]);
            expect(copy?.workspaceProjectId).toBe(rootId);
            expect(copy?.canvasTitle).toBe("分镜画布 副本");
            expect(copy?.nodes).toEqual(root?.nodes);
            expect(copy?.connections).toEqual(root?.connections);
            expect(copy?.viewport).toEqual(root?.viewport);
            expect(copy?.timeline).toEqual(root?.timeline);
            expect(copy?.nodes).not.toBe(root?.nodes);
            expect(copy?.connections).not.toBe(root?.connections);
            expect(copy?.timeline).not.toBe(root?.timeline);
        } finally {
            withCanvasStorePersistenceSuppressed(() => useCanvasStore.setState({ projects: previousProjects }));
        }
    });

    test("duplicates the live editor snapshot when the selected canvas is currently open", () => {
        const editor = readFileSync(new URL("../src/pages/canvas/project.tsx", import.meta.url), "utf8");

        expect(editor).toContain("const sourceSnapshot = canvasId === projectId");
        expect(editor).toContain("nodes: nodesRef.current");
        expect(editor).toContain("connections: connectionsRef.current");
        expect(editor).toContain("chatSessions: chatSessionsRef.current");
        expect(editor).toContain("activeChatId: activeChatIdRef.current");
        expect(editor).toContain("viewport: viewportRef.current");
    });

    test("exposes the four canvas-level actions from every switcher item", () => {
        const topBar = readFileSync(new URL("../src/pages/canvas/canvas-project-top-bar.tsx", import.meta.url), "utf8");
        const editor = readFileSync(new URL("../src/pages/canvas/project.tsx", import.meta.url), "utf8");

        expect(topBar).toContain("在新窗口打开");
        expect(topBar).toContain("重命名画布");
        expect(topBar).toContain("复制画布");
        expect(topBar).toContain("删除画布");
        expect(topBar).toContain("onOpenCanvasInNewWindow");
        expect(topBar).toContain("onRenameCanvas");
        expect(topBar).toContain("onDuplicateCanvas");
        expect(topBar).toContain("onDeleteCanvas");
        expect(editor).toContain("onOpenCanvasInNewWindow=");
        expect(editor).toContain("onRenameCanvas=");
        expect(editor).toContain("onDuplicateCanvas=");
        expect(editor).toContain("onDeleteCanvas=");
    });

    test("matches the LibTV canvas switcher hierarchy and hover affordance", () => {
        const topBar = readFileSync(new URL("../src/pages/canvas/canvas-project-top-bar.tsx", import.meta.url), "utf8");
        const styles = readFileSync(new URL("../src/styles/globals.css", import.meta.url), "utf8");

        expect(topBar).not.toContain('label: <Link to="/canvas">画布列表</Link>');
        expect(topBar).toContain('className="canvas-topbar-canvas-menu-panel"');
        expect(topBar).toContain('aria-label="新建画布"');
        expect(topBar).toContain("canvas-topbar-canvas-menu-check");
        expect(topBar).toContain("canvas-topbar-canvas-menu-more");
        expect(styles).toContain(".canvas-topbar-canvas-menu-row:hover .canvas-topbar-canvas-menu-more");
        expect(styles).toContain(".canvas-topbar-canvas-menu-row:hover .canvas-topbar-canvas-menu-check");
    });

    test("renames a canvas inline without opening a modal", () => {
        const topBar = readFileSync(new URL("../src/pages/canvas/canvas-project-top-bar.tsx", import.meta.url), "utf8");

        expect(topBar).not.toContain("<Modal\n                open={Boolean(renameCanvas)}");
        expect(topBar).toContain('className="canvas-topbar-canvas-menu-rename-input"');
        expect(topBar).toContain("onBlur={() => void commitCanvasRename()}");
        expect(topBar).toContain('if (event.key === "Escape") cancelCanvasRename();');
        expect(topBar).toContain("setCanvasMenuOpen(true)");
    });
});
