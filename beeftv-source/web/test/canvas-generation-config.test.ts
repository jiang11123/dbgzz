import { expect, test } from "bun:test";
import { buildCanvasGenerationRequirements, buildGenerationConfig, resolvedCanvasGenerationRequirements } from "@/lib/canvas/canvas-generation-config";
import { defaultModelCapabilityConfig } from "@/lib/model-capabilities";
import { modelCompatibilityError } from "@/lib/model-selection";
import { defaultConfig, type AiConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const input = { textCount: 1, imageCount: 1, videoCount: 0, audioCount: 0, characterCount: 0 };
const node: CanvasNodeData = { id: "target", type: CanvasNodeType.Video, title: "target", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { model: "channel::cinema-text", seconds: "5", size: "16:9", generateAudio: "false", watermark: "false" } };

function config(): AiConfig {
    const profiles = [
        { model: "cinema-text", displayName: "Cinema", operation: "text_to_video", images: 0 },
        { model: "cinema-image", displayName: "Cinema", operation: "image_to_video", images: 1 },
        { model: "other-image", displayName: "Other product", operation: "image_to_video", images: 9 },
    ].map(({ operation, images, ...model }) => {
        const capabilityConfig = defaultModelCapabilityConfig();
        capabilityConfig.video!.operations = [operation];
        capabilityConfig.video!.references.maxImages = images;
        return { ...model, capability: "video" as const, capabilityConfig };
    });
    return { ...defaultConfig, channels: [{ id: "channel", name: "Test", baseUrl: "https://example.test", apiKey: "fixture", apiFormat: "openai", models: profiles.map(profile => profile.model), modelProfiles: profiles }], videoModel: "channel::cinema-text", videoSeconds: "10", videoGenerateAudio: "true", videoWatermark: "true" };
}

test("preview and resolved selection use node duration and the same display-model group", () => {
    const global = config();
    const preview = buildCanvasGenerationRequirements(global, node, "video", input);
    expect(preview.videoSeconds).toBe("5");
    expect(preview.options).toMatchObject({ videoSeconds: 5, videoGenerateAudio: false, videoWatermark: false });
    const resolved = buildGenerationConfig(global, node, "video", preview);
    expect(resolved.model).toBe("channel::cinema-image");
    expect(modelCompatibilityError(resolved, resolved.model, buildCanvasGenerationRequirements(resolved, node, "video", input))).toBe("");
    expect(global.videoModel).toBe("channel::cinema-text");
    expect(node.metadata?.model).toBe("channel::cinema-text");
});

test("incompatible references never select a different display-model product", () => {
    const global = config();
    const twoImages = { ...input, imageCount: 2 };
    const requirements = buildCanvasGenerationRequirements(global, node, "video", twoImages);
    const resolved = buildGenerationConfig(global, node, "video", requirements);
    expect(resolved.model).toBe("channel::cinema-text");
    expect(modelCompatibilityError(resolved, resolved.model, requirements)).not.toBe("");
});

test("character preview reserves minimum capacity while resolved input uses actual images", () => {
    const global = config();
    const preview = buildCanvasGenerationRequirements(global, node, "video", { ...input, imageCount: 0, characterCount: 1 });
    const resolved = buildCanvasGenerationRequirements(global, node, "video", { ...input, imageCount: 2, characterCount: 0 });
    expect(preview.input).toMatchObject({ imageCount: 0, characterCount: 1 });
    expect(resolved.input).toMatchObject({ imageCount: 2, characterCount: 0 });
});

test("image preview uses canvas count and transparent background instead of unrelated global count", () => {
    const global = { ...defaultConfig, count: "1", canvasImageCount: "4", transparentBackground: "true" };
    const imageNode = { ...node, type: CanvasNodeType.Image, metadata: { transparentBackground: "false" } };
    expect(buildCanvasGenerationRequirements(global, imageNode, "image", input).options).toMatchObject({ count: 4, transparentBackground: false });
});

test("workflow requirements do not apply model-only request options", () => {
    expect(buildCanvasGenerationRequirements({ ...config(), taskWorkflowProvider: "runninghub" }, node, "video", input).options).toBeUndefined();
});

test("resolved requirements retain admitted defaults rather than restoring raw node or canvas values", () => {
    const resolved = { ...defaultConfig, count: "2", canvasImageCount: "4", size: "3:2" };
    const imageNode = { ...node, type: CanvasNodeType.Image, metadata: { count: 9, size: "1:1" } };
    expect(resolvedCanvasGenerationRequirements(resolved, imageNode, "image", input).options).toMatchObject({ count: 2, size: "3:2" });
});
