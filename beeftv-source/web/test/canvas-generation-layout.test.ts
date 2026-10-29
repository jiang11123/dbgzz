import { describe, expect, test } from "bun:test";

import { canGenerateImageInPlace, canGenerateMediaInPlace, canGenerateTextInPlace, findAvailableGenerationGroupPosition, generationFailureNodeStatus, imageGenerationGroupSize, planTextGenerationTargets } from "../src/lib/canvas/canvas-generation-layout";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

function node(id: string, x: number, y: number, width = 340, height = 240): CanvasNodeData {
    return { id, type: CanvasNodeType.Image, title: id, position: { x, y }, width, height };
}

describe("findAvailableGenerationGroupPosition", () => {
    test("首选位置没有占用时保持原坐标", () => {
        expect(findAvailableGenerationGroupPosition([node("source", 0, 0)], { x: 436, y: 0 }, { width: 340, height: 240 })).toEqual({ x: 436, y: 0 });
    });

    test("右侧已有节点时选择距离更短的下方空位", () => {
        expect(findAvailableGenerationGroupPosition([node("occupied", 436, 0)], { x: 436, y: 0 }, { width: 340, height: 240 })).toEqual({ x: 436, y: 276 });
    });

    test("纵向大节点遮挡时改为向右避让", () => {
        expect(findAvailableGenerationGroupPosition([node("occupied", 436, 0, 340, 900)], { x: 436, y: 0 }, { width: 340, height: 240 })).toEqual({ x: 812, y: 0 });
    });

    test("按完整批次范围检测碰撞", () => {
        const groupSize = imageGenerationGroupSize({ width: 340, height: 240 }, { width: 340, height: 240 }, 4);
        expect(groupSize).toEqual({ width: 1176, height: 564 });
        expect(findAvailableGenerationGroupPosition([node("child-area", 900, 0)], { x: 436, y: 0 }, groupSize)).toEqual({ x: 436, y: 276 });
    });
});

describe("canGenerateImageInPlace", () => {
    test("重生成失败时保留已有结果的成功状态", () => {
        expect(generationFailureNodeStatus(true)).toBe("success");
        expect(generationFailureNodeStatus(false)).toBe("error");
    });

    test("生成器首次生成和再生成都复用原节点", () => {
        expect(canGenerateImageInPlace(node("empty", 0, 0))).toBe(true);
        expect(canGenerateImageInPlace({ ...node("generator", 0, 0), metadata: { nodeRole: "generator" } })).toBe(true);
        expect(canGenerateImageInPlace({ ...node("generator-result", 0, 0), metadata: { nodeRole: "generator", content: "image-url" } })).toBe(true);
        expect(canGenerateImageInPlace({ ...node("generated-result", 0, 0), metadata: { nodeRole: "result", resultOrigin: "generated", generationType: "generation", prompt: "revise", content: "image-url" } })).toBe(true);
        expect(canGenerateImageInPlace({ ...node("result", 0, 0), metadata: { content: "image-url" } })).toBe(false);
        expect(canGenerateImageInPlace({ ...node("derived-result", 0, 0), metadata: { nodeRole: "result", resultOrigin: "derived", prompt: "source", content: "image-url" } })).toBe(false);
        expect(canGenerateImageInPlace({ ...node("copy", 0, 0), metadata: { nodeRole: "result", content: "image-url", generationResultPlacement: "replace-node" } })).toBe(true);
        expect(canGenerateImageInPlace({ ...node("copy", 0, 0), metadata: { content: "image-url", generationResultPlacement: "new-version", copiedFromNodeId: "source" } })).toBe(false);
        expect(canGenerateImageInPlace({ ...node("text", 0, 0), type: CanvasNodeType.Text })).toBe(false);
    });

    test("文本生成器在有无结果时都复用原节点", () => {
        const text = { ...node("text", 0, 0), type: CanvasNodeType.Text };
        expect(canGenerateTextInPlace(text)).toBe(true);
        expect(canGenerateTextInPlace({ ...text, metadata: { content: "旧文本", prompt: "改写" } })).toBe(true);
        expect(canGenerateTextInPlace({ ...text, type: CanvasNodeType.Config })).toBe(false);
    });

    test("重写已有文本时仍把成功结果落回原文本节点", () => {
        const plan = planTextGenerationTargets({
            nodeId: "text-source",
            sourceNode: { ...node("text-source", 0, 0), type: CanvasNodeType.Text, metadata: { content: "旧正文" } },
            isConfigNode: false,
            count: 1,
            createId: () => "unexpected-child",
        });

        expect(plan).toEqual({ generateInPlace: true, targetIds: ["text-source"], childIds: [] });
    });

    test("文本批量生成将首个结果替换原节点，其余结果使用新节点", () => {
        const plan = planTextGenerationTargets({ nodeId: "text-source", sourceNode: { ...node("text-source", 0, 0), type: CanvasNodeType.Text }, isConfigNode: false, count: 3, createId: (() => { let id = 0; return () => `child-${++id}`; })() });

        expect(plan).toEqual({ generateInPlace: true, targetIds: ["text-source", "child-1", "child-2"], childIds: ["child-1", "child-2"] });
    });

    test("视频复制节点与图片使用相同的结果落点规则", () => {
        const video = { ...node("video-copy", 0, 0), type: CanvasNodeType.Video, metadata: { content: "video-url", generationResultPlacement: "replace-node" as const } };
        expect(canGenerateMediaInPlace(video, CanvasNodeType.Video)).toBe(true);
        expect(canGenerateMediaInPlace({ ...video, metadata: { ...video.metadata, generationResultPlacement: "new-version" } }, CanvasNodeType.Video)).toBe(false);
    });
});
