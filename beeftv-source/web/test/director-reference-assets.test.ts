import { describe, expect, test } from "bun:test";

import { connectDirectorReferenceNodes } from "@/lib/canvas/director/director-reference-assets";
import { createCanvasNode } from "@/lib/canvas/canvas-project-domain";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

function image(id: string, title: string): CanvasNodeData {
    return { ...createCanvasNode(CanvasNodeType.Image, { x: 0, y: 0 }), id, title, metadata: { content: `/assets/${id}.png` } };
}

describe("导演台参考图片接入画布资源图", () => {
    test("只连接有效图片、去重，并把图片 id 合并到导演节点引用", () => {
        const target = { ...createCanvasNode(CanvasNodeType.Video, { x: 0, y: 0 }, { workflowKind: "shot", composerContent: "夜晚的街道" }), id: "director", metadata: { workflowKind: "shot", composerContent: "夜晚的街道", referenceAssetNodeIds: ["old-image"] } } as CanvasNodeData;
        const first = image("image-1", "参考图 1");
        const second = image("image-2", "参考图 2");
        const nonImage = { ...first, id: "video-1", type: CanvasNodeType.Video };

        const result = connectDirectorReferenceNodes([target, first, second, nonImage], [], ["image-1", "image-1", "image-2", "video-1"], "director", () => "edge");

        expect(result.connections.map(({ fromNodeId, toNodeId }) => [fromNodeId, toNodeId])).toEqual([["image-1", "director"], ["image-2", "director"]]);
        expect(result.linkedSourceIds).toEqual(["image-1", "image-2"]);
        expect(result.nodes[0].metadata?.referenceAssetNodeIds).toEqual(["old-image", "image-1", "image-2"]);
        expect(result.nodes[0].metadata?.composerContent).toBe("夜晚的街道");
    });

    test("重复操作不重复建边，非导演节点和缺失资源不改变数据", () => {
        const target = { ...createCanvasNode(CanvasNodeType.Video, { x: 0, y: 0 }, { workflowKind: "shot" }), id: "director" };
        const source = image("image-1", "参考图");
        const edge = { id: "existing", fromNodeId: source.id, toNodeId: target.id };
        const input = [target, source];

        const repeated = connectDirectorReferenceNodes(input, [edge], [source.id], target.id, () => "new-edge");
        const orphan = connectDirectorReferenceNodes(input, [], ["missing"], target.id, () => "new-edge");
        const ordinaryNode = { ...target, metadata: { workflowKind: "free" } };
        const rejected = connectDirectorReferenceNodes([ordinaryNode, source], [], [source.id], target.id, () => "new-edge");

        expect(repeated.connections).toEqual([edge]);
        expect(orphan.connections).toEqual([]);
        expect(orphan.nodes).toBe(input);
        expect(rejected.connections).toEqual([]);
    });

    test("替换图源只解除导演台已连接的旧图片，不删除素材或其他节点连接", () => {
        const target = { ...createCanvasNode(CanvasNodeType.Video, { x: 0, y: 0 }, { workflowKind: "shot", referenceAssetNodeIds: ["old-image", "old-video"] }), id: "director" };
        const oldImage = image("old-image", "旧参考图");
        const nextImage = image("new-image", "新参考图");
        const video = { ...createCanvasNode(CanvasNodeType.Video, { x: 0, y: 0 }), id: "old-video" };
        const unrelatedEdge = { id: "video-edge", fromNodeId: video.id, toNodeId: target.id };
        const imageEdge = { id: "image-edge", fromNodeId: oldImage.id, toNodeId: target.id };
        const input = [target, oldImage, nextImage, video];

        const result = connectDirectorReferenceNodes(input, [imageEdge, unrelatedEdge], [nextImage.id], target.id, () => "new-edge", "replace");

        expect(result.connections.map(({ fromNodeId, toNodeId }) => [fromNodeId, toNodeId])).toEqual([["old-video", "director"], ["new-image", "director"]]);
        expect(result.nodes.find((node) => node.id === target.id)?.metadata?.referenceAssetNodeIds).toEqual(["old-video", "new-image"]);
        expect(result.nodes.some((node) => node.id === oldImage.id)).toBe(true);
    });
});
