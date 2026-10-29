import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import {
    canvasMediaNodeOrigin,
    canvasMediaNodeRole,
    canvasMediaNodeSemanticLabel,
    canOpenCanvasNodePromptPanel,
    isCanvasMediaResultNode,
    mediaGeneratorMetadata,
    mediaResultMetadata,
    normalizeCanvasMediaNodeSemantics,
} from "../src/lib/canvas/canvas-node-semantics";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";
import { getNodeGenerationMode } from "../src/lib/canvas/node-registry";
import "../src/lib/canvas/node-registry/definitions/builtin-nodes";
import { createCanvasNode } from "../src/lib/canvas/canvas-project-domain";

const canvasNodeSource = readFileSync(resolve(import.meta.dir, "../src/components/canvas/canvas-node.tsx"), "utf8");

function mediaNode(type: CanvasNodeType.Image | CanvasNodeType.Video | CanvasNodeType.Audio, metadata: CanvasNodeData["metadata"] = {}): CanvasNodeData {
    return { id: `${type}-1`, type, title: type, position: { x: 0, y: 0 }, width: 320, height: 180, metadata };
}

describe("canvas media node semantics", () => {
    test("empty media nodes are generators and own the prompt panel", () => {
        for (const type of [CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio] as const) {
            const node = mediaNode(type);
            expect(canvasMediaNodeRole(node)).toBe("generator");
            expect(canOpenCanvasNodePromptPanel(node)).toBe(true);
        }
    });

    test("populated media generators keep the prompt panel and expose result tools", () => {
        for (const type of [CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio] as const) {
            const node = mediaNode(type, { nodeRole: "generator", content: `blob:${type}`, status: "success" });
            expect(canvasMediaNodeRole(node)).toBe("generator");
            expect(canOpenCanvasNodePromptPanel(node)).toBe(true);
            expect(isCanvasMediaResultNode(node)).toBe(true);
        }
    });

    test("generated result nodes keep their prompt panel and generation capability", () => {
        for (const type of [CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio] as const) {
            const node = mediaNode(type, { nodeRole: "result", resultOrigin: "generated", content: `blob:${type}`, prompt: "revise the result", generationType: "generation" });
            expect(canOpenCanvasNodePromptPanel(node)).toBe(true);
            expect(getNodeGenerationMode(node)).toBe(type === CanvasNodeType.Image ? "image" : type === CanvasNodeType.Video ? "video" : "audio");
        }
    });

    test("uploaded, library, and derived results do not acquire generation controls", () => {
        const imported = mediaNode(CanvasNodeType.Image, { nodeRole: "result", resultOrigin: "upload", content: "image", prompt: "filename" });
        const derived = mediaNode(CanvasNodeType.Video, { nodeRole: "result", resultOrigin: "derived", content: "video", prompt: "source prompt", videoTrimSourceNodeId: "source" });
        expect(canOpenCanvasNodePromptPanel(imported)).toBe(false);
        expect(canOpenCanvasNodePromptPanel(derived)).toBe(false);
        expect(getNodeGenerationMode(imported)).toBeNull();
        expect(getNodeGenerationMode(derived)).toBeNull();
    });

    test("explicit role wins over legacy content inference", () => {
        expect(canvasMediaNodeRole(mediaNode(CanvasNodeType.Video, { nodeRole: "generator", content: "preview" }))).toBe("generator");
        expect(canvasMediaNodeRole(mediaNode(CanvasNodeType.Audio, { nodeRole: "result" }))).toBe("result");
    });

    test("legacy source fields recover upload library generated and derived origins", () => {
        expect(canvasMediaNodeOrigin(mediaNode(CanvasNodeType.Video, { content: "upload", fileUpload: "uploading" }))).toBe("upload");
        expect(canvasMediaNodeOrigin(mediaNode(CanvasNodeType.Audio, { content: "library", assetId: "asset-1" }))).toBe("library");
        expect(canvasMediaNodeOrigin(mediaNode(CanvasNodeType.Image, { content: "generated", taskId: "task-1" }))).toBe("generated");
        expect(canvasMediaNodeOrigin(mediaNode(CanvasNodeType.Audio, { content: "track", audioExtractSourceNodeId: "video-1" }))).toBe("derived");
        expect(canvasMediaNodeOrigin(mediaNode(CanvasNodeType.Video, { content: "clip", videoTrimSourceNodeId: "video-1" }))).toBe("derived");
    });

    test("normalization persists inferred semantics without mutating legacy nodes", () => {
        const legacy = mediaNode(CanvasNodeType.Audio, { content: "track", audioExtractSourceNodeId: "video-1" });
        const normalized = normalizeCanvasMediaNodeSemantics(legacy);
        expect(normalized).not.toBe(legacy);
        expect(legacy.metadata?.nodeRole).toBeUndefined();
        expect(normalized.metadata?.nodeRole).toBe("result");
        expect(normalized.metadata?.resultOrigin).toBe("derived");
    });

    test("creation helpers stamp role and origin while preserving caller metadata", () => {
        expect(mediaGeneratorMetadata({ generationMode: "video", prompt: "move" })).toEqual({
            generationMode: "video", prompt: "move", nodeRole: "generator", resultOrigin: undefined,
        });
        expect(mediaResultMetadata("upload", { content: "blob:video", prompt: "filename" })).toEqual({
            content: "blob:video", prompt: "filename", nodeRole: "result", resultOrigin: "upload",
        });
        expect(isCanvasMediaResultNode(mediaNode(CanvasNodeType.Audio, { nodeRole: "result", content: "track" }))).toBe(true);
        expect(isCanvasMediaResultNode(mediaNode(CanvasNodeType.Audio))).toBe(false);
    });

    test("generated media remains a generation target after it has a result", () => {
        expect(getNodeGenerationMode(mediaNode(CanvasNodeType.Image))).toBe("image");
        expect(getNodeGenerationMode(mediaNode(CanvasNodeType.Video, { nodeRole: "generator", content: "clip" }))).toBe("video");
        expect(getNodeGenerationMode(mediaNode(CanvasNodeType.Audio, { nodeRole: "result", content: "track" }))).toBeNull();
    });

    test("semantic labels distinguish generators and every result origin", () => {
        expect(canvasMediaNodeSemanticLabel(mediaNode(CanvasNodeType.Video, { nodeRole: "generator" }))).toBe("生成节点");
        expect(canvasMediaNodeSemanticLabel(mediaNode(CanvasNodeType.Video, { nodeRole: "result", resultOrigin: "upload", content: "clip" }))).toBe("已上传");
        expect(canvasMediaNodeSemanticLabel(mediaNode(CanvasNodeType.Video, { nodeRole: "result", resultOrigin: "library", content: "clip" }))).toBe("素材库");
        expect(canvasMediaNodeSemanticLabel(mediaNode(CanvasNodeType.Video, { nodeRole: "result", resultOrigin: "generated", content: "clip" }))).toBe("AI 生成");
        expect(canvasMediaNodeSemanticLabel(mediaNode(CanvasNodeType.Video, { nodeRole: "result", resultOrigin: "derived", content: "clip" }))).toBe("处理结果");
    });

    test("keeps internal media semantics out of node-card presentation", () => {
        expect(canvasNodeSource).toContain('data-media-role={canvasMediaNodeRole(data) || undefined}');
        expect(canvasNodeSource).toContain('data-result-origin={canvasMediaNodeOrigin(data) || undefined}');
        expect(canvasNodeSource).not.toContain("MediaSemanticBadge");
        expect(canvasNodeSource).not.toContain("ResourceLabelBadge");
        expect(canvasNodeSource).not.toContain("ResourceStorageBadge");
        expect(canvasNodeSource).not.toContain("AssetTagBadges");
        expect(canvasNodeSource).toContain("dimensionLabel={null}");
    });

    test("central node factory always persists media semantics", () => {
        expect(createCanvasNode(CanvasNodeType.Video, { x: 0, y: 0 }).metadata?.nodeRole).toBe("generator");
        const derived = createCanvasNode(CanvasNodeType.Audio, { x: 0, y: 0 }, { content: "track", audioExtractSourceNodeId: "video-1" });
        expect(derived.metadata?.nodeRole).toBe("result");
        expect(derived.metadata?.resultOrigin).toBe("derived");
    });
});
