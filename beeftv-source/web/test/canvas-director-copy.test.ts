import { describe, expect, test } from "bun:test";

import { isolateCopiedDirectorScenes, isolateCopiedNodeMetadata } from "@/lib/canvas/canvas-node-copy";
import { createDirectorScene } from "@/lib/canvas/director/director-scene";
import { upsertDirectorSceneById } from "@/lib/canvas/director/director-session";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

function fixture() {
    const scene = createDirectorScene("Original");
    scene.shots[0].prompt = "Keep the actor waving";
    scene.shots[0].previewNodeId = "preview";
    const node: CanvasNodeData = {
        id: "director", type: CanvasNodeType.Director, title: "Original", position: { x: 0, y: 0 }, width: 640, height: 640,
        metadata: { workflowKind: "shot", directorSceneId: scene.id, directorShotId: scene.shots[0].id, directorPreviewNodeId: "preview", directorClayVideoNodeId: "clay" },
    };
    return { scene, node };
}

function copy(node: CanvasNodeData, scenes: ReturnType<typeof createDirectorScene>[], idMap = new Map([[node.id, "copy"]])) {
    return isolateCopiedDirectorScenes([{ ...node, id: idMap.get(node.id)!, metadata: isolateCopiedNodeMetadata(node, idMap) }], scenes, idMap);
}

describe("canvas director copies own their scene and outputs", () => {
    test("editing and saving a parameter variant cannot mutate the original scene", () => {
        const { scene, node } = fixture();
        const original = structuredClone(scene);
        const isolated = copy(node, [scene]);
        const cloned = isolated.scenes[0];
        cloned.objects[0].transform.position[0] = 12;
        cloned.shots[0].prompt = "A different take";
        const saved = upsertDirectorSceneById([scene, ...isolated.scenes], cloned);
        expect(saved.find((item) => item.id === scene.id)).toEqual(original);
        expect(cloned.id).not.toBe(scene.id);
        expect(cloned.shots[0].id).not.toBe(scene.shots[0].id);
        expect(isolated.nodes[0].metadata?.directorSceneId).toBe(cloned.id);
        expect(isolated.nodes[0].metadata?.directorShotId).toBe(cloned.shots[0].id);
        expect(cloned.activeShotId).toBe(cloned.shots[0].id);
        expect(isolated.nodes[0].metadata?.directorClayVideoNodeId).toBeUndefined();
        expect(isolated.nodes[0].metadata?.directorPreviewNodeId).toBeUndefined();
        expect(cloned.shots[0].previewNodeId).toBeUndefined();
    });

    test("copying a group including its outputs points only at the copied output nodes", () => {
        const { scene, node } = fixture();
        const isolated = copy(node, [scene], new Map([[node.id, "copy"], ["preview", "preview-copy"], ["clay", "clay-copy"]]));
        expect(isolated.nodes[0].metadata?.directorClayVideoNodeId).toBe("clay-copy");
        expect(isolated.nodes[0].metadata?.directorPreviewNodeId).toBe("preview-copy");
        expect(isolated.scenes[0].shots[0].previewNodeId).toBe("preview-copy");
        expect(node.metadata?.directorClayVideoNodeId).toBe("clay");
        expect(scene.shots[0].previewNodeId).toBe("preview");
    });

    test("serialized clipboard scene survives source edits and repeated cross-project pastes", () => {
        const { scene, node } = fixture();
        const clipboard = JSON.parse(JSON.stringify({ nodes: [node], directorScenes: [scene] }));
        scene.objects[0].transform.position[0] = 50;
        const first = copy(clipboard.nodes[0], clipboard.directorScenes);
        const second = copy(clipboard.nodes[0], clipboard.directorScenes);
        first.scenes[0].objects[0].transform.position[0] = 25;
        expect(second.scenes[0].objects[0].transform.position[0]).toBe(0);
        expect(second.scenes[0].shots[0].prompt).toBe("Keep the actor waving");
        expect(second.scenes[0].id).not.toBe(first.scenes[0].id);
        expect(second.scenes[0].shots[0].id).not.toBe(first.scenes[0].shots[0].id);
        expect(clipboard.directorScenes[0].objects[0].transform.position[0]).toBe(0);
    });

    test("missing clipboard scene cannot bind a pasted card to the old scene id", () => {
        const { node } = fixture();
        node.metadata!.directorCoverStorageKey = "resource:old-cover";
        const isolated = copy(node, []);
        expect(isolated.scenes).toEqual([]);
        expect(isolated.nodes[0].metadata?.directorSceneId).toBeUndefined();
        expect(isolated.nodes[0].metadata?.directorShotId).toBeUndefined();
        expect(isolated.nodes[0].metadata?.directorCoverStorageKey).toBeUndefined();
        expect(isolated.nodes[0].metadata?.directorClayVideoNodeId).toBeUndefined();
    });
});
