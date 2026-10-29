import { expect, spyOn, test } from "bun:test";
import { App } from "antd";
import { renderToStaticMarkup } from "react-dom/server";
import { useCanvasDirector } from "../src/pages/canvas/use-canvas-director";
import { useCanvasStore } from "../src/stores/canvas/use-canvas-store";
import { getNodeGenerationMode } from "../src/lib/canvas/node-registry";
import "../src/lib/canvas/node-registry/definitions";
import type { CanvasNodeData } from "../src/types/canvas";
import type { DirectorScene } from "../src/types/director";

test("creating a director shot opens an empty workbench at the requested canvas position", () => {
    const projectId = useCanvasStore.getState().createProject("empty director test");
    const nodesRef = { current: [] as CanvasNodeData[] };
    let openedNodeId: string | null = null;
    let savedScenes: DirectorScene[] = [];
    let createDirectorShot!: ReturnType<typeof useCanvasDirector>["createDirectorShot"];
    const useApp = spyOn(App, "useApp").mockReturnValue({ message: { success: () => {} } } as ReturnType<typeof App.useApp>);

    function Harness() {
        const director = useCanvasDirector({
            projectId,
            directorNodeId: null,
            directorScenes: [],
            nodesRef,
            connectionsRef: { current: [] },
            getCanvasCenter: () => ({ x: 0, y: 0 }),
            setNodes: (value) => { nodesRef.current = typeof value === "function" ? value(nodesRef.current) : value; },
            setConnections: () => {},
            setSelectedNodeIds: () => {},
            setSelectedConnectionId: () => {},
            setDirectorNodeId: (value) => { openedNodeId = typeof value === "function" ? value(openedNodeId) : value; },
            updateProject: (_id, patch) => { savedScenes = patch.directorScenes; },
        });
        createDirectorShot = director.createDirectorShot;
        return null;
    }

    try {
        renderToStaticMarkup(<Harness />);
        createDirectorShot({ x: 120, y: 240 });
        expect(nodesRef.current).toHaveLength(1);
        expect(nodesRef.current[0].position).toEqual({ x: -200, y: -80 });
        expect(nodesRef.current[0].type).toBe("director");
        expect(nodesRef.current[0].title).toBe("导演台 1");
        expect(nodesRef.current[0].metadata).not.toHaveProperty("generationMode");
        expect(nodesRef.current[0].metadata).not.toHaveProperty("videoEditOperation");
        expect(nodesRef.current[0].metadata).not.toHaveProperty("composerContent");
        expect(getNodeGenerationMode(nodesRef.current[0])).toBeNull();
        expect(savedScenes).toHaveLength(1);
        expect(savedScenes[0].objects).toEqual([]);
        expect(openedNodeId).toBe(nodesRef.current[0].id);

        createDirectorShot({ x: 500, y: 600 });
        expect(nodesRef.current[1].title).toBe("导演台 2");
    } finally {
        useApp.mockRestore();
        useCanvasStore.setState((state) => ({ projects: state.projects.filter((project) => project.id !== projectId) }));
    }
});
