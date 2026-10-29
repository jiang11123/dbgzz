import { describe, expect, test } from "bun:test";

import { isolateCopiedNodeMetadata, nextCopiedNodeTitle } from "@/lib/canvas/canvas-node-copy";
import { rebaseCanvasDocumentThreeWay, settleInFlightGenerationOverlay } from "@/lib/canvas/canvas-document-rebase";
import { resetGenerationTaskMetadata } from "@/lib/canvas/canvas-project-generation";
import { buildNodeGenerationContext } from "@/components/canvas/canvas-node-generation";
import { canvasGenerationTaskNodes } from "@/pages/canvas/canvas-generation-failure";
import type { GenerationTask } from "@/services/api/task-center";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

describe("canvas node copy title", () => {
    test("首次复制使用 copy1，后续按已有最大序号递增", () => {
        expect(nextCopiedNodeTitle("女明星角色三视图", ["女明星角色三视图"])).toBe("女明星角色三视图_copy1");
        expect(nextCopiedNodeTitle("女明星角色三视图", ["女明星角色三视图", "女明星角色三视图_copy1"])).toBe("女明星角色三视图_copy2");
        expect(nextCopiedNodeTitle("女明星角色三视图", ["女明星角色三视图_copy1", "女明星角色三视图_copy3"])).toBe("女明星角色三视图_copy4");
    });

    test("复制已有副本时仍使用原始名称计算下一序号", () => {
        expect(nextCopiedNodeTitle("女明星角色三视图_copy1", ["女明星角色三视图", "女明星角色三视图_copy1"])).toBe("女明星角色三视图_copy2");
    });

    test("兼容旧版空格 Copy 后缀", () => {
        expect(nextCopiedNodeTitle("女明星角色三视图 Copy", ["女明星角色三视图", "女明星角色三视图 Copy"])).toBe("女明星角色三视图_copy1");
    });

    test("同一批粘贴可以通过预留标题连续分配序号", () => {
        const titles = new Set(["节点", "节点_copy1"]);
        const first = nextCopiedNodeTitle("节点", titles);
        titles.add(first);
        const second = nextCopiedNodeTitle("节点", titles);
        expect([first, second]).toEqual(["节点_copy2", "节点_copy3"]);
    });
});

describe("canvas generation copy metadata", () => {
    test.each([CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio])("%s 副本不继承原节点的生成提交标记", (type) => {
        const source: CanvasNodeData = {
            id: "source", type, title: "结果", position: { x: 0, y: 0 }, width: 340, height: 240,
            metadata: { content: "saved-media", assetId: "saved-asset", taskId: "old-task", generationEffectKeys: ["attach-node:old-task:source:0"] },
        };
        const metadata = isolateCopiedNodeMetadata(source, new Map([[source.id, "copy"]]));
        expect(metadata.generationEffectKeys).toBeUndefined();
        expect(metadata.taskId).toBeUndefined();
        expect(metadata.content).toBe("saved-media");
        expect(metadata.assetId).toBe("saved-asset");
        expect(source.metadata?.generationEffectKeys).toEqual(["attach-node:old-task:source:0"]);
    });

    test("媒体副本保留提示词与参考字段，并明确原地回填生成结果", () => {
        const source: CanvasNodeData = {
            id: "source",
            type: CanvasNodeType.Video,
            title: "镜头",
            position: { x: 0, y: 0 },
            width: 340,
            height: 240,
            metadata: {
                content: "video-url",
                prompt: "相同提示词",
                videoStartFrameNodeId: "reference-start",
                videoEndFrameNodeId: "reference-end",
                generationResultPlacement: "new-version",
            },
        };

        const metadata = isolateCopiedNodeMetadata(source, new Map([[source.id, "copy"]]));

        expect(metadata.prompt).toBe("相同提示词");
        expect(metadata.videoStartFrameNodeId).toBe("reference-start");
        expect(metadata.videoEndFrameNodeId).toBe("reference-end");
        expect(metadata.copiedFromNodeId).toBe("source");
        expect(metadata.generationResultPlacement).toBe("replace-node");
    });

    test("复制到副本的入边继续解析为同一张参考图", () => {
        const reference: CanvasNodeData = {
            id: "reference",
            type: CanvasNodeType.Image,
            title: "角色参考",
            position: { x: 0, y: 0 },
            width: 340,
            height: 240,
            metadata: { content: "reference-url", mimeType: "image/png" },
        };
        const copy: CanvasNodeData = {
            id: "copy",
            type: CanvasNodeType.Image,
            title: "结果_copy1",
            position: { x: 400, y: 0 },
            width: 340,
            height: 240,
            metadata: { content: "old-result", prompt: "保持角色一致", copiedFromNodeId: "source", generationResultPlacement: "replace-node" },
        };

        const context = buildNodeGenerationContext(copy.id, [reference, copy], [{ id: "copy-reference", fromNodeId: reference.id, toNodeId: copy.id }], copy.metadata!.prompt!, []);

        expect(context.prompt).toBe("保持角色一致");
        expect(context.referenceImages.map((image) => image.id)).toEqual([reference.id]);
    });

    test("复制视频保留旧媒体等待新结果，新任务绑定后仍采用新视频", () => {
        const source: CanvasNodeData = {
            id: "video-source",
            type: CanvasNodeType.Video,
            title: "原视频",
            position: { x: 0, y: 0 },
            width: 360,
            height: 640,
            metadata: {
                content: "/api/v1/resources/old-video/file",
                storageKey: "resource:old-video",
                assetId: "asset-old",
                videoPreview: { content: "/api/v1/resources/old-preview/file", storageKey: "resource:old-preview" },
                durationMs: 5000,
                hasAudio: true,
                naturalWidth: 720,
                naturalHeight: 1280,
                bytes: 102400,
                mimeType: "video/mp4",
                prompt: "原提示词",
                videoStartFrameNodeId: "ref-start",
                status: "success",
                taskId: "task-old",
            },
        };
        const copiedMetadata = isolateCopiedNodeMetadata(source, new Map([[source.id, "video-copy"]]));
        const copiedNode: CanvasNodeData = {
            ...source,
            id: "video-copy",
            title: "原视频_copy1",
            metadata: copiedMetadata,
        };

        const inPlaceLoadingMetadata = resetGenerationTaskMetadata(copiedNode.metadata, "loading");
        expect(inPlaceLoadingMetadata.content).toBe(source.metadata!.content);
        expect(inPlaceLoadingMetadata.storageKey).toBe(source.metadata!.storageKey);
        expect(inPlaceLoadingMetadata.assetId).toBe(source.metadata!.assetId);
        expect(inPlaceLoadingMetadata.videoPreview).toEqual(source.metadata!.videoPreview);
        expect(inPlaceLoadingMetadata.taskId).toBeUndefined();
        expect(inPlaceLoadingMetadata.copiedFromNodeId).toBe("video-source");
        expect(inPlaceLoadingMetadata.generationResultPlacement).toBe("replace-node");
        expect(inPlaceLoadingMetadata.videoStartFrameNodeId).toBe("ref-start");
        expect(inPlaceLoadingMetadata.status).toBe("loading");

        const loadingNode: CanvasNodeData = {
            ...copiedNode,
            metadata: {
                ...inPlaceLoadingMetadata,
                prompt: "新提示词",
            },
        };
        const succeededTask: GenerationTask = {
            id: "task-new",
            type: "canvas_video",
            status: "succeeded",
            prompt: "新提示词",
            attempts: 1,
            createdAt: "2026-10-14T09:02:00.000Z",
            updatedAt: "2026-10-14T09:04:37.000Z",
            outputs: [{ outputIndex: 0, mediaType: "video", materializedAssetId: "asset-new", resourceId: "new-video" }],
        };

        // 任务刚到 succeeded、尚未消费产物前，bindGenerationTask 必须保持 loading overlay，不能把旧视频误判成已完成产物。
        const [boundLoadingNode] = canvasGenerationTaskNodes([loadingNode], loadingNode.id, succeededTask);
        expect(boundLoadingNode.metadata?.status).toBe("loading");
        expect(boundLoadingNode.metadata?.taskId).toBe("task-new");

        const makeProject = (nodes: CanvasNodeData[], revision: number): CanvasProject => ({
            id: "canvas-1",
            revision,
            title: "测试画布",
            createdAt: "2026-10-14T09:00:00.000Z",
            updatedAt: "2026-10-14T09:04:37.000Z",
            nodes,
            connections: [],
            chatSessions: [],
            activeChatId: null,
            backgroundMode: "grid",
            showImageInfo: false,
            viewport: { x: 0, y: 0, k: 1 },
            directorScenes: [],
        });

        const base = makeProject([copiedNode], 150);
        const local = makeProject([boundLoadingNode], 150);
        const remote = makeProject([
            {
                ...boundLoadingNode,
                metadata: {
                    ...boundLoadingNode.metadata,
                    status: "success",
                    taskStatus: "succeeded",
                    taskProgress: 100,
                    content: "/api/v1/resources/new-video/file",
                    storageKey: "resource:new-video",
                    assetId: "asset-new",
                    mimeType: "video/mp4",
                    bytes: 204800,
                    naturalWidth: 720,
                    naturalHeight: 1280,
                    durationMs: 5000,
                    videoPreview: undefined,
                },
            },
        ], 152);

        const settled = settleInFlightGenerationOverlay({ base, local, remote });
        const rebased = rebaseCanvasDocumentThreeWay({ base, local: settled, remote });
        expect(rebased.conflict).toBe(false);
        expect(rebased.project.nodes[0]?.metadata?.status).toBe("success");
        expect(rebased.project.nodes[0]?.metadata?.content).toBe("/api/v1/resources/new-video/file");
        expect(rebased.project.nodes[0]?.metadata?.storageKey).toBe("resource:new-video");
        expect(rebased.project.nodes[0]?.metadata?.assetId).toBe("asset-new");
        expect(rebased.project.nodes[0]?.metadata?.videoPreview).toBeUndefined();
    });
});
