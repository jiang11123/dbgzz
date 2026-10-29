import { describe, expect, test } from "bun:test";

import { shouldCaptureDirectorCover, shouldCommitDirectorCover, directorCoverMetadata } from "@/lib/canvas/director/director-cover-write";
import { createDirectorScene } from "@/lib/canvas/director/director-scene";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const scene = createDirectorScene("镜头");
const shotId = scene.shots[0].id;
const node: CanvasNodeData = {
    id: "director-1", type: CanvasNodeType.Video, title: "镜头", position: { x: 0, y: 0 }, width: 384, height: 360,
    metadata: { workflowKind: "shot", directorSceneId: scene.id, directorShotId: shotId },
};

describe("导演封面回写判定", () => {
    test("没有封面要采集；已有同修订封面不重复采集", () => {
        expect(shouldCaptureDirectorCover(node, scene)).toBe(true);
        expect(shouldCaptureDirectorCover({ ...node, metadata: { ...node.metadata, directorCoverStorageKey: "image:key", directorCoverSceneUpdatedAt: scene.updatedAt } }, scene)).toBe(false);
        expect(shouldCaptureDirectorCover({ ...node, metadata: { ...node.metadata, directorCoverStorageKey: "image:key", directorCoverSceneUpdatedAt: "older" } }, scene)).toBe(true);
    });

    test("当前项目、节点、场景、镜头和请求代都一致时允许回写", () => {
        expect(shouldCommitDirectorCover({ projectId: "project-1", currentProjectId: "project-1", node, scene, shotId, expectedSceneUpdatedAt: scene.updatedAt, requestId: "r1", latestRequestId: "r1" })).toBe(true);
    });

    test("任一权威身份变化都拒绝旧截图", () => {
        const input = { projectId: "project-1", currentProjectId: "project-1", node, scene, shotId, expectedSceneUpdatedAt: scene.updatedAt, requestId: "r1", latestRequestId: "r1" };
        expect(shouldCommitDirectorCover({ ...input, currentProjectId: "project-2" })).toBe(false);
        expect(shouldCommitDirectorCover({ ...input, node: undefined })).toBe(false);
        expect(shouldCommitDirectorCover({ ...input, node: { ...node, metadata: { ...node.metadata, directorSceneId: "other" } } })).toBe(false);
        expect(shouldCommitDirectorCover({ ...input, scene: { ...scene, updatedAt: "newer" } })).toBe(false);
        expect(shouldCommitDirectorCover({ ...input, shotId: "missing" })).toBe(false);
        expect(shouldCommitDirectorCover({ ...input, latestRequestId: "r2" })).toBe(false);
    });

    test("只持久化可重载资源地址，不把临时 object URL 写入项目", () => {
        const image = { storageKey: "image:local:key", url: "blob:http://localhost/temporary", width: 100, height: 100, bytes: 1, mimeType: "image/png" };
        expect(directorCoverMetadata(image, scene.updatedAt)).toEqual({ directorCoverStorageKey: "image:local:key", directorCoverUrl: undefined, directorCoverSceneUpdatedAt: scene.updatedAt });
        expect(directorCoverMetadata({ ...image, url: "/api/resources/asset-1/file" }, scene.updatedAt).directorCoverUrl).toBe("/api/resources/asset-1/file");
    });
});
