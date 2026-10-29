import { expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { useCanvasDirector } from "../src/pages/canvas/use-canvas-director";
import { createDirectorScene } from "../src/lib/canvas/director/director-scene";
import { stampCanvasNodeChanges } from "../src/lib/canvas/canvas-node-timestamps";
import { useCanvasStore } from "../src/stores/canvas/use-canvas-store";
import * as imageStorage from "../src/services/image-storage";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

test("cover write preserves the old node until the canvas setter stamps its revision", async () => {
    const scene = createDirectorScene("镜头");
    const before = "2026-01-01T00:00:00.000Z", after = "2026-01-02T00:00:00.000Z";
    const node: CanvasNodeData = { id: "node-1", type: CanvasNodeType.Video, title: "镜头", position: { x: 0, y: 0 }, width: 384, height: 360, createdAt: before, updatedAt: before, metadata: { workflowKind: "shot", directorSceneId: scene.id, directorShotId: scene.shots[0].id } };
    const nodesRef = { current: [node] };
    const projectId = useCanvasStore.getState().createProject("cover regression");
    useCanvasStore.getState().updateProject(projectId, { directorScenes: [scene], nodes: [node] });
    const upload = spyOn(imageStorage, "uploadImage").mockResolvedValue({ storageKey: "image:cover", url: "blob:cover", width: 100, height: 100, bytes: 1, mimeType: "image/png" });
    let director!: ReturnType<typeof useCanvasDirector>;
    function Harness() {
        director = useCanvasDirector({ projectId, directorNodeId: node.id, directorScenes: [scene], nodesRef, connectionsRef: { current: [] }, getCanvasCenter: () => ({ x: 0, y: 0 }),
            setNodes: (value) => {
                expect(nodesRef.current[0]).toBe(node);
                const next = typeof value === "function" ? value(nodesRef.current) : value;
                nodesRef.current = stampCanvasNodeChanges(nodesRef.current, next, after);
            },
            setConnections: () => {}, setSelectedNodeIds: () => {}, setSelectedConnectionId: () => {}, setDirectorNodeId: () => {}, updateProject: () => {},
        });
        return null;
    }
    try {
        renderToStaticMarkup(<Harness />);
        await director.captureDirectorCover({ scene, shotId: scene.shots[0].id, beauty: new Blob(["cover"]) });
        expect(nodesRef.current[0].updatedAt).toBe(after);
        expect(nodesRef.current[0].metadata?.directorCoverStorageKey).toBe("image:cover");
    } finally {
        upload.mockRestore();
        useCanvasStore.setState((state) => ({ projects: state.projects.filter((project) => project.id !== projectId) }));
    }
});
