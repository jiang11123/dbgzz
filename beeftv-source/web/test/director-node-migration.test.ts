import { expect, test } from "bun:test";

import { migrateDirectorCanvas, normalizeDirectorCanvasNode } from "../src/lib/canvas/director/director-node-migration";
import { createDirectorScene } from "../src/lib/canvas/director/director-scene";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

test("legacy director video nodes become named director nodes without generation prompt metadata", () => {
    const node: CanvasNodeData = {
        id: "legacy-director",
        type: CanvasNodeType.Video,
        title: "镜头 4",
        position: { x: 20, y: 30 },
        width: 768,
        height: 704,
        metadata: {
            workflowKind: "shot",
            workflowTitle: "镜头 4",
            directorSceneId: "scene-4",
            directorShotId: "shot-4",
            generationMode: "video",
            videoEditOperation: "text_to_video",
            composerContent: "旧的节点级提示词",
            prompt: "旧的模型提示词",
        },
    };

    const scene = createDirectorScene();
    scene.id = "scene-4";
    scene.shots[0].id = "shot-4";
    scene.shots[0].prompt = "已有镜头描述";
    const result = migrateDirectorCanvas([node], [scene]);
    const migrated = result.nodes[0];
    expect(result.directorScenes[0].shots[0].prompt).toBe("已有镜头描述\n\n旧的节点级提示词\n\n旧的模型提示词");
    const again = migrateDirectorCanvas(result.nodes, result.directorScenes);
    expect(again.nodes[0]).toBe(migrated);
    expect(again.directorScenes).toBe(result.directorScenes);
    expect(scene.shots[0].prompt).toBe("已有镜头描述");
    expect(migrateDirectorCanvas([node], []).nodes[0].metadata?.composerContent).toBe("旧的节点级提示词");

    expect(migrated.type).toBe("director");
    expect(migrated.title).toBe("导演台");
    expect(migrated.position).toEqual({ x: 20, y: 30 });
    expect(migrated.metadata).toMatchObject({ workflowKind: "shot", directorSceneId: "scene-4", directorShotId: "shot-4" });
    expect(migrated.metadata).not.toHaveProperty("generationMode");
    expect(migrated.metadata).not.toHaveProperty("videoEditOperation");
    expect(migrated.metadata).not.toHaveProperty("composerContent");
    expect(migrated.metadata).not.toHaveProperty("prompt");
});

test("regular video nodes retain their media type and metadata", () => {
    const node: CanvasNodeData = {
        id: "video-1",
        type: CanvasNodeType.Video,
        title: "普通视频",
        position: { x: 0, y: 0 },
        width: 720,
        height: 405,
        metadata: { content: "/clip.mp4", generationMode: "video" },
    };

    expect(normalizeDirectorCanvasNode(node)).toBe(node);
});

test("already migrated director nodes retain a user-edited title", () => {
    const node: CanvasNodeData = {
        id: "director-custom-title",
        type: CanvasNodeType.Director,
        title: "导演台 夜景分镜",
        position: { x: 0, y: 0 },
        width: 640,
        height: 640,
        metadata: { directorSceneId: "scene-1" },
    };

    expect(normalizeDirectorCanvasNode(node)).toBe(node);
    const scene = createDirectorScene();
    scene.id = "scene-1";
    scene.shots[0].prompt = "  保留已有镜头的排版\n";
    expect(migrateDirectorCanvas([node], [scene]).directorScenes[0]).toBe(scene);
});

test("legacy default-size director cards are enlarged while user-sized cards remain unchanged", () => {
    const legacyDefault: CanvasNodeData = {
        id: "director-default-size",
        type: CanvasNodeType.Director,
        title: "导演台 1",
        position: { x: 0, y: 0 },
        width: 560,
        height: 560,
        metadata: { directorSceneId: "scene-default" },
    };
    const customSize = { ...legacyDefault, id: "director-custom-size", width: 720, height: 620 };

    expect(normalizeDirectorCanvasNode(legacyDefault)).toMatchObject({ width: 640, height: 640 });
    expect(normalizeDirectorCanvasNode(customSize)).toBe(customSize);
});
