import { expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { useCanvasDirector } from "@/pages/canvas/use-canvas-director";
import { createDirectorScene } from "@/lib/canvas/director/director-scene";
import { migrateDirectorCanvas } from "@/lib/canvas/director/director-node-migration";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import * as imageStorage from "@/services/image-storage";
import * as assetSync from "@/services/project-asset-sync";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

test("实际回写画布后重新迁移，不把编译输出追加进用户场景描述", async () => {
    const scene = createDirectorScene();
    scene.shots[0].prompt = "夜景中的两个人";
    const node: CanvasNodeData = { id: "director", type: CanvasNodeType.Director, title: "导演台", position: { x: 0, y: 0 }, width: 640, height: 640, metadata: { directorSceneId: scene.id, directorShotId: scene.shots[0].id } };
    const nodesRef = { current: [node] };
    const projectId = useCanvasStore.getState().createProject("director output migration");
    useCanvasStore.getState().updateProject(projectId, { nodes: [node], directorScenes: [scene] });
    const upload = spyOn(imageStorage, "uploadImage").mockResolvedValue({ storageKey: "image:test-output", url: "blob:test-output", width: 8, height: 8, bytes: 1, mimeType: "image/png" });
    const asset = spyOn(assetSync, "ensureCanvasNodeAsset").mockResolvedValue({ assetId: "asset-output", created: false, linkedToProject: false, confirmed: true });
    let director!: ReturnType<typeof useCanvasDirector>;
    function Harness() {
        director = useCanvasDirector({ projectId, directorNodeId: node.id, directorScenes: [scene], nodesRef, connectionsRef: { current: [] }, getCanvasCenter: () => ({ x: 0, y: 0 }),
            setNodes: (value) => { nodesRef.current = typeof value === "function" ? value(nodesRef.current) : value; },
            setConnections: () => {}, setSelectedNodeIds: () => {}, setSelectedConnectionId: () => {}, setDirectorNodeId: () => {}, updateProject: useCanvasStore.getState().updateProject,
        });
        return null;
    }
    try {
        renderToStaticMarkup(<Harness />);
        const compiled = "导演台构图：中景、固定机位。夜景中的两个人";
        await director.applyDirectorOutput({ scene, shot: scene.shots[0], prompt: compiled, beauty: new Blob(["image"]) });
        const source = nodesRef.current.find((item) => item.id === node.id)!;
        expect(source.metadata).not.toHaveProperty("composerContent");
        expect(source.metadata).not.toHaveProperty("prompt");
        expect(nodesRef.current.find((item) => item.type === CanvasNodeType.Image)?.metadata?.prompt).toBe(compiled);
        const scenes = useCanvasStore.getState().projects.find((project) => project.id === projectId)!.directorScenes;
        expect(migrateDirectorCanvas(nodesRef.current, scenes).directorScenes[0].shots[0].prompt).toBe("夜景中的两个人");
    } finally {
        upload.mockRestore(); asset.mockRestore();
        useCanvasStore.setState((state) => ({ projects: state.projects.filter((project) => project.id !== projectId) }));
    }
});
