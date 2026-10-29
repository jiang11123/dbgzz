import { expect, spyOn, test } from "bun:test";
import { compileNodeGenerationReferences, hydrateNodeGenerationContext, type NodeGenerationContext } from "../src/components/canvas/canvas-node-generation";
import type { AiConfig } from "../src/stores/use-config-store";
import * as projects from "../src/services/api/projects";
import * as resources from "../src/services/api/resources";
import { modelCapabilityConfigFor } from "../src/lib/model-capabilities";
import { assertVideoCapability } from "../src/services/api/video-validation";
import * as imageStorage from "../src/services/image-storage";
import { h3ResolvedReferenceOrder } from "../src/lib/h3-video";

const seedanceConfig = { model: "native::seedance-2.0", videoEditOperation: "reference_to_video", channels: [{ id: "native", models: ["seedance-2.0"], modelProfiles: [{ model: "seedance-2.0", protocol: "volcengine-ark-video" }] }] } as AiConfig;

test("stored character voice keeps duration through canvas hydration and preflight", async () => {
    const character = spyOn(projects, "getProjectCharacter").mockResolvedValue({
        asset: { id: "character-1", title: "爸爸" },
        character: { versionId: "version-1", definition: {}, representations: [], voice: { profile: { sampleResourceId: "voice-1" }, instructions: "" } },
    } as Awaited<ReturnType<typeof projects.getProjectCharacter>>);
    const resource = spyOn(resources, "getResource").mockResolvedValue({ id: "voice-1", mimeType: "audio/mpeg", objectKey: "voice.mp3", durationMs: 2500, size: 1234 } as resources.RemoteResource);
    try {
        const context: NodeGenerationContext = {
            prompt: "test",
            referenceImages: [],
            referenceVideos: [],
            referenceAudios: [],
            characterReferences: [{ nodeId: "character-node", assetId: "character-1" }],
            resolvedCharacterVersions: [],
            resolvedCharacterVoices: [],
            textCount: 1,
            imageCount: 0,
            videoCount: 0,
            audioCount: 0,
        };
        const hydrated = await hydrateNodeGenerationContext(context, "canvas-1", "project-1", "video", true);
        expect(hydrated.referenceAudios[0]?.durationMs).toBe(2500);
        expect(hydrated.referenceAudios[0]?.bytes).toBe(1234);
        const model = "seedance-2.5";
        const profile = modelCapabilityConfigFor({ channels: [{ id: "beef", models: [model], modelProfiles: [{ model, protocol: "newapi-channel-2" }] }] }, `beef::${model}`).video!;
        expect(() => assertVideoCapability(profile, [], [], hydrated.referenceAudios, "5")).not.toThrow();
    } finally {
        character.mockRestore();
        resource.mockRestore();
    }
});

test("character images and voice retain the source card for H3 ordering", async () => {
    const character = spyOn(projects, "getProjectCharacter").mockResolvedValue({
        asset: { id: "character-1", title: "爸爸" },
        character: { versionId: "version-1", definition: {}, representations: [{ resourceId: "front", role: "front" }, { resourceId: "side", role: "side" }], voice: { profile: { sampleResourceId: "voice-1" }, instructions: "" } },
    } as Awaited<ReturnType<typeof projects.getProjectCharacter>>);
    const resource = spyOn(resources, "getResource").mockResolvedValue({ id: "voice-1", mimeType: "audio/mpeg", objectKey: "voice.mp3", durationMs: 2500, size: 1234 } as resources.RemoteResource);
    const images = spyOn(imageStorage, "imageToDataUrl").mockResolvedValue("data:image/png;base64,fixture");
    try {
        const hydrated = await hydrateNodeGenerationContext({ prompt: "test", referenceImages: [], referenceVideos: [], referenceAudios: [], characterReferences: [{ nodeId: "character-node", assetId: "character-1" }], resolvedCharacterVersions: [], resolvedCharacterVoices: [], textCount: 1, imageCount: 0, videoCount: 0, audioCount: 0 }, "canvas-1", "project-1", "video", true);
        expect(hydrated.referenceImages).toHaveLength(2);
        expect(hydrated.referenceImages.every((image) => image.sourceNodeId === "character-node")).toBe(true);
        expect(hydrated.referenceAudios[0]?.sourceNodeId).toBe("character-node");
        expect(h3ResolvedReferenceOrder(["character-node"], [...hydrated.referenceImages, ...hydrated.referenceAudios])).toEqual(["character-reference-1", "character-reference-2", "character-voice-character-1"]);
    } finally {
        character.mockRestore();
        resource.mockRestore();
        images.mockRestore();
    }
});

test("video promptOnly keeps character identity bound to actual non-contiguous image slots", async () => {
    const character = spyOn(projects, "getProjectCharacter").mockImplementation(async (_projectId, assetId) => ({
        asset: { id: assetId, title: assetId === "b" ? "小乙" : "小甲" },
        character: { versionId: "v1", definition: { personality: "不应自动注入的性格设定" }, representations: [
            { resourceId: `${assetId}-front`, role: "front" },
            { resourceId: `${assetId}-side`, role: "side" },
        ] },
    } as Awaited<ReturnType<typeof projects.getProjectCharacter>>));
    try {
        const prompt = "@角色1 在右侧拿手机，@角色2 在左侧说：你找我？";
        const hydrated = compileNodeGenerationReferences(await hydrateNodeGenerationContext({
            prompt,
            referenceImages: [{ id: "scene", name: "scene.png", type: "image/png", dataUrl: "", storageKey: "resource:scene" }],
            referenceVideos: [], referenceAudios: [],
            characterReferences: [{ nodeId: "node-b", assetId: "b" }, { nodeId: "node-a", assetId: "a" }],
            resolvedCharacterVersions: [], resolvedCharacterVoices: [], textCount: 0, imageCount: 1, videoCount: 0, audioCount: 0,
        }, "canvas", "project", "video", true, false), seedanceConfig, "reference_to_video");
        expect(hydrated.referenceImages.map(image => image.storageKey)).toEqual(["resource:scene", "resource:b-front", "resource:a-front", "resource:b-side", "resource:a-side"]);
        expect(hydrated.prompt).toContain("@角色1 与「小乙」指同一角色。该角色外观参考 @图片2、@图片4");
        expect(hydrated.prompt).toContain("@角色2 与「小甲」指同一角色。该角色外观参考 @图片3、@图片5");
        expect(hydrated.prompt).toContain(prompt);
        expect(hydrated.prompt).not.toContain("不应自动注入");
        expect(hydrated.prompt).not.toContain("@音频");
    } finally {
        character.mockRestore();
    }
});

test("two characters can bind an already connected voice sample without duplicate uploads", async () => {
    const character = spyOn(projects, "getProjectCharacter").mockImplementation(async (_projectId, assetId) => ({
        asset: { id: assetId, title: assetId },
        character: { versionId: "v1", definition: {}, representations: [], voice: { profile: { sampleResourceId: "shared-voice" }, instructions: "" } },
    } as Awaited<ReturnType<typeof projects.getProjectCharacter>>));
    const resource = spyOn(resources, "getResource").mockRejectedValue(new Error("sample is already connected"));
    try {
        const audio = { id: "sample", name: "sample.mp3", type: "audio/mpeg", url: "https://example.com/sample.mp3", storageKey: "resource:shared-voice", durationMs: 2500 };
        const hydrated = compileNodeGenerationReferences(await hydrateNodeGenerationContext({
            prompt: "@角色1 说早安，@角色2 回答你好。", referenceImages: [], referenceVideos: [], referenceAudios: [audio],
            characterReferences: [{ nodeId: "a", assetId: "甲" }, { nodeId: "b", assetId: "乙" }],
            resolvedCharacterVersions: [], resolvedCharacterVoices: [], textCount: 0, imageCount: 0, videoCount: 0, audioCount: 1,
        }, "canvas", "project", "video", true, false), seedanceConfig, "reference_to_video");
        expect(hydrated.referenceAudios).toEqual([audio]);
        expect(resource).not.toHaveBeenCalled();
        expect(hydrated.prompt).toContain("@角色1 与「甲」指同一角色。该角色音色参考 @音频1。");
        expect(hydrated.prompt).toContain("@角色2 与「乙」指同一角色。该角色音色参考 @音频1。");
        expect(hydrated.prompt).not.toContain("@图片");
    } finally {
        character.mockRestore();
        resource.mockRestore();
    }
});

test("character binding does not alter TTS, images, H3 ordering, frames or workflows", async () => {
    const character = spyOn(projects, "getProjectCharacter").mockResolvedValue({ asset: { id: "a", title: "甲" }, character: { versionId: "v1", definition: {}, representations: [] } } as Awaited<ReturnType<typeof projects.getProjectCharacter>>);
    const base: NodeGenerationContext = { prompt: "你好", referenceImages: [], referenceVideos: [], referenceAudios: [], characterReferences: [{ nodeId: "a", assetId: "a" }], resolvedCharacterVersions: [], resolvedCharacterVoices: [], textCount: 0, imageCount: 0, videoCount: 0, audioCount: 0 };
    try {
        for (const mode of ["audio", "image", "text"] as const) {
            const hydrated = await hydrateNodeGenerationContext(base, "canvas", "project", mode, false, false);
            expect(hydrated.prompt).toBe("你好");
            expect(hydrated.characterReferenceBindings).toBeUndefined();
        }
        const hydrated = await hydrateNodeGenerationContext(base, "canvas", "project", "video", false, false);
        expect(hydrated.prompt).toBe("你好");
        for (const config of [
            { ...seedanceConfig, taskWorkflowProvider: "workflow" },
            { ...seedanceConfig, model: "fal::minimax/h3-max", channels: [{ id: "fal", models: ["minimax/h3-max"], modelProfiles: [{ model: "minimax/h3-max", protocol: "newapi" }] }] },
        ]) expect(compileNodeGenerationReferences(hydrated, config as AiConfig, "reference_to_video").prompt).toBe("你好");
        expect(compileNodeGenerationReferences(hydrated, seedanceConfig, "image_to_video").prompt).toBe("你好");
    } finally { character.mockRestore(); }
});
