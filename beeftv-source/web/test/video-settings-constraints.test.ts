import { expect, spyOn, test } from "bun:test";
import { videoSettingsConstraints } from "../src/lib/video-settings-constraints";
import { createVideoGenerationsTask } from "../src/services/api/video-provider-newapi";
import { createVideoTransport } from "../src/services/api/video-transport";
import { videoResponseTools } from "../src/services/api/video-response";
import { resolveModelRequestConfig } from "../src/stores/use-config-store";
import { h3AspectConfig, h3Models, h3StyleModels } from "./fixtures/h3-aspect-config";
import { buildVideoGenerationMetadata } from "../src/lib/canvas/canvas-project-generation";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeMetadata } from "../src/types/canvas";
import { hydrateNodeGenerationContext } from "../src/components/canvas/canvas-node-generation";
import * as projects from "../src/services/api/projects";
import * as imageStorage from "../src/services/image-storage";
import * as resources from "../src/services/api/resources";
import * as videoResponse from "../src/services/api/video-response";

for (const model of h3Models) {
    test(`${model}: settings reflect the actual keyframe payload and restore the selected ratio`, async () => {
        const config = h3AspectConfig(model);
        const savedSize = config.size;
        const bodies: Record<string, unknown>[] = [];
        const resolved = resolveModelRequestConfig(config, config.model);
        const deps = { response: videoResponseTools, transport: { ...createVideoTransport(resolved), post: async <T>(_url: string, body: unknown) => { bodies.push(body as Record<string, unknown>); return { id: "fixture" } as T; } } };
        const images = [{ id: "frame", name: "frame.png", type: "image/png", dataUrl: "data:image/png;base64,dGVzdA==" }];
        const frames = [
            { videoStartFrameNodeId: "frame" },
            { videoEndFrameNodeId: "frame" },
            { videoStartFrameNodeId: "frame", videoEndFrameNodeId: "frame" },
        ];
        for (const metadata of frames) {
            await createVideoGenerationsTask(deps, resolved, model, "Fixture", images, [], [], metadata);
            expect(bodies.at(-1)!.aspect_ratio).toBeUndefined();
            expect(videoSettingsConstraints(config, { imageCount: 1 }, metadata).ratioLabel).toBe(metadata.videoStartFrameNodeId ? "随首帧图片" : "随尾帧图片");
        }
        await createVideoGenerationsTask(deps, resolved, model, "Fixture", [], [], []);
        expect(bodies.at(-1)!.aspect_ratio).toBe("9:16");
        expect(videoSettingsConstraints(config, {})).toEqual({});
        expect(videoSettingsConstraints(config, {}, { videoEndFrameNodeId: "disconnected" })).toEqual({});
        expect(config.size).toBe(savedSize);
    });
}

test("H3 base ordinary references retain an independent ratio", () => {
    const config = h3AspectConfig("minimax-h3");
    expect(videoSettingsConstraints(config, { imageCount: 1 }, { videoEditOperation: "reference_to_video" })).toEqual({});
    expect(videoSettingsConstraints(config, { imageCount: 1, videoCount: 1 })).toEqual({});
    expect(videoSettingsConstraints(config, { imageCount: 1, audioCount: 2 })).toEqual({});
});

test("Max and Turbo treat ordinary image inputs as keyframes", () => {
    for (const model of h3Models.slice(1)) expect(videoSettingsConstraints(h3AspectConfig(model), { imageCount: 1 }).ratioLabel).toBe("随首帧图片");
});

test("same-name models on custom endpoints keep their own protocol controls", () => {
    for (const model of h3Models) expect(videoSettingsConstraints(h3AspectConfig(model, "https://custom.example.com"), { imageCount: 1 })).toEqual({});
});

test("switching to Seedance preserves its existing settings constraints", () => {
    const config = { ...h3AspectConfig(), model: "seedance-2.5" };
    expect(videoSettingsConstraints(config, { imageCount: 1 }).ratioLabel).toBe("随首帧");
    expect(videoSettingsConstraints(config, { videoCount: 1 }, { videoEditOperation: "inpaint" })).toEqual({ ratioLabel: "随原视频", durationLocked: true });
    expect(videoSettingsConstraints(config, { characterCount: 1 }).ratioLabel).toBeUndefined();
});

test("a character card cover alone does not determine keyframe mode", () => {
    for (const model of h3Models) {
        const config = h3AspectConfig(model);
        expect(videoSettingsConstraints(config, { characterCount: 1 }).ratioLabel).toBeUndefined();
        expect(videoSettingsConstraints(config, { imageCount: 1, characterCount: 1 }, { videoStartFrameNodeId: "frame" }).ratioLabel).toBeUndefined();
        expect(videoSettingsConstraints(config, { imageCount: 1, characterCount: 1 }, { videoEndFrameNodeId: "frame" }).ratioLabel).toBeUndefined();
    }
    expect(videoSettingsConstraints(h3AspectConfig(), { characterCount: 1 }).ratioHelp).toContain("多素材参考生成使用所选比例");
});

test("mixed H3 references with an explicit frame are rejected before dispatch", async () => {
    const config = h3AspectConfig("minimax-h3");
    const resolved = resolveModelRequestConfig(config, config.model);
    const deps = { response: videoResponseTools, transport: { ...createVideoTransport(resolved), post: async () => { throw new Error("must not dispatch"); } } };
    const image = { id: "frame", name: "frame.png", type: "image/png", dataUrl: "data:image/png;base64,dGVzdA==" };
    const video = { id: "video", name: "video.mp4", type: "video/mp4", url: "https://example.com/fixture.mp4" };
    await expect(createVideoGenerationsTask(deps, resolved, "minimax-h3", "Fixture", [image], [video], [], { videoStartFrameNodeId: "frame" })).rejects.toThrow("参考模式不能同时指定关键帧");
    expect(videoSettingsConstraints(config, { imageCount: 1, videoCount: 1 }, { videoStartFrameNodeId: "frame" })).toEqual({});
});

test("character representations mixed with explicit frames explain the pre-dispatch rejection", async () => {
    for (const model of h3Models) {
        const config = h3AspectConfig(model);
        const resolved = resolveModelRequestConfig(config, config.model);
        let dispatched = 0;
        const deps = { response: videoResponseTools, transport: { ...createVideoTransport(resolved), post: async <T>() => { dispatched += 1; return { id: "fixture" } as T; } } };
        const images = ["frame", "character-reference-1"].map((id) => ({ id, name: "frame.png", type: "image/png", dataUrl: "data:image/png;base64,dGVzdA==" }));
        for (const metadata of [{ videoStartFrameNodeId: "frame" }, { videoEndFrameNodeId: "frame" }]) {
            await expect(createVideoGenerationsTask(deps, resolved, model, "Fixture", images, [], [], metadata)).rejects.toThrow("图片须指定角色");
            expect(videoSettingsConstraints(config, { imageCount: 1, characterCount: 1 }, metadata).ratioHelp).toContain(model === "minimax-h3-max" ? "首尾帧生成不能混用角色参考图" : "不能与指定的首尾帧同时使用");
        }
        expect(dispatched).toBe(0);
    }
});

for (const model of h3Models) {
    test(`${model}: ratio controls match canvas metadata and the dispatched request`, async () => {
        const config = h3AspectConfig(model);
        const resolved = resolveModelRequestConfig(config, config.model);
        const bodies: Record<string, unknown>[] = [];
        const deps = { response: videoResponseTools, transport: { ...createVideoTransport(resolved), post: async <T>(_url: string, body: unknown) => { bodies.push(body as Record<string, unknown>); return { id: "fixture" } as T; } } };
        const image = (id: string) => ({ id, name: `${id}.png`, type: "image/png", dataUrl: "data:image/png;base64,dGVzdA==" });
        const video = { id: "motion", name: "motion.mp4", type: "video/mp4", url: "https://example.com/motion.mp4" };
        const audio = (id: string) => ({ id, name: `${id}.mp3`, type: "audio/mpeg", url: `https://example.com/${id}.mp3` });
        const scenarios: Array<{ images: string[]; metadata?: Partial<CanvasNodeMetadata>; videos?: boolean; audios?: boolean; locked: boolean }> = [
            { images: ["first"], locked: true },
            { images: ["first"], metadata: { videoEditOperation: "image_to_video" }, locked: true },
            { images: ["first"], metadata: { videoEditOperation: "reference_to_video" }, locked: false },
            { images: ["first"], videos: true, locked: false },
            { images: ["first"], audios: true, locked: false },
            { images: ["first", "second", "third"], locked: false },
            ...(model === "minimax-h3-max" ? [
                { images: ["first", "last", "middle"], metadata: { videoStartFrameNodeId: "first", videoEndFrameNodeId: "last", videoMiddleFrameNodeId: "middle", videoMiddleFrameTime: 2 }, locked: false },
                { images: ["first", "character-reference"], metadata: { videoStartFrameNodeId: "first", videoEditOperation: "reference_to_video" as const }, locked: false },
            ] : []),
        ];
        for (const scenario of scenarios) {
            const images = scenario.images.map(image), videos = scenario.videos ? [video] : [], audios = scenario.audios ? [audio("voice1"), audio("voice2")] : [];
            const node = { id: "node", type: CanvasNodeType.Video, metadata: scenario.metadata } as CanvasNodeData;
            const metadata = buildVideoGenerationMetadata(node, { referenceImages: images, referenceVideos: videos, referenceAudios: audios }, config);
            const constraints = videoSettingsConstraints(config, { imageCount: images.length, videoCount: videos.length, audioCount: audios.length }, node.metadata);
            await createVideoGenerationsTask(deps, resolved, model, "Fixture", images, videos, audios, metadata);
            expect(Boolean(constraints.ratioLabel)).toBe(scenario.locked);
            expect(bodies.at(-1)!.aspect_ratio).toBe(scenario.locked ? undefined : "9:16");
        }
        expect(config.size).toBe("9:16");
    });
}

test("pre-hydration character controls remain editable when actual views switch the request to reference mode", async () => {
    const character = spyOn(projects, "getProjectCharacter").mockResolvedValue({
        asset: { id: "character-1", title: "角色" },
        character: { versionId: "version-1", definition: {}, representations: [{ resourceId: "front", role: "front" }, { resourceId: "side", role: "side" }] },
    } as Awaited<ReturnType<typeof projects.getProjectCharacter>>);
    const imageData = spyOn(imageStorage, "imageToDataUrl").mockResolvedValue("data:image/png;base64,dGVzdA==");
    const resourceBlob = spyOn(resources, "getResourceBlob").mockResolvedValue(new Blob(["test"], { type: "image/png" }));
    const encodeBlob = spyOn(videoResponse, "blobToDataUrl").mockResolvedValue("data:image/png;base64,dGVzdA==");
    try {
        const image = { id: "scene", name: "scene.png", type: "image/png", dataUrl: "data:image/png;base64,dGVzdA==" };
        const hydrated = await hydrateNodeGenerationContext({ prompt: "test", referenceImages: [image], referenceVideos: [], referenceAudios: [], characterReferences: [{ nodeId: "card", assetId: "character-1" }], resolvedCharacterVersions: [], resolvedCharacterVoices: [], textCount: 1, imageCount: 1, videoCount: 0, audioCount: 0 }, "canvas-1", "project-1", "video");
        expect(hydrated.referenceImages).toHaveLength(3);
        for (const model of h3Models) {
            const config = h3AspectConfig(model), resolved = resolveModelRequestConfig(config, config.model);
            const bodies: Record<string, unknown>[] = [];
            const deps = { response: videoResponseTools, transport: { ...createVideoTransport(resolved), post: async <T>(_url: string, body: unknown) => { bodies.push(body as Record<string, unknown>); return { id: "fixture" } as T; } } };
            for (const metadata of [undefined, ...(model === "minimax-h3-max" ? [{ videoStartFrameNodeId: "scene" }] : [])]) {
                const node = { id: "node", type: CanvasNodeType.Video, metadata } as CanvasNodeData;
                const ui = videoSettingsConstraints(config, { imageCount: 1, characterCount: 1 }, metadata);
                expect(ui.ratioLabel).toBeUndefined();
                const submission = buildVideoGenerationMetadata(node, hydrated, config);
                await createVideoGenerationsTask(deps, resolved, model, "Fixture", hydrated.referenceImages, [], [], submission);
                expect(bodies.at(-1)!.aspect_ratio).toBe("9:16");
                expect(bodies.at(-1)!.operation).toBe("reference_to_video");
            }
        }
    } finally { character.mockRestore(); imageData.mockRestore(); resourceBlob.mockRestore(); encodeBlob.mockRestore(); }
});

for (const model of h3StyleModels) {
    test(`${model}: image styles lock ratio while text-only styles keep it`, async () => {
        const config = h3AspectConfig(model), resolved = resolveModelRequestConfig(config, config.model);
        const bodies: Record<string, unknown>[] = [];
        const deps = { response: videoResponseTools, transport: { ...createVideoTransport(resolved), post: async <T>(_url: string, body: unknown) => { bodies.push(body as Record<string, unknown>); return { id: "fixture" } as T; } } };
        const images = [{ id: "first", name: "first.png", type: "image/png", dataUrl: "data:image/png;base64,dGVzdA==" }];
        expect(videoSettingsConstraints(config, { imageCount: 1 }).ratioLabel).toBe("随首帧图片");
        await createVideoGenerationsTask(deps, resolved, model, "Fixture", images, [], []);
        expect(bodies.at(-1)!.aspect_ratio).toBeUndefined();
        expect(videoSettingsConstraints(config, {})).toEqual({});
        await createVideoGenerationsTask(deps, resolved, model, "Fixture", [], [], []);
        expect(bodies.at(-1)!.aspect_ratio).toBe("9:16");
        expect(videoSettingsConstraints(h3AspectConfig(model, "https://custom.example.com"), { imageCount: 1 })).toEqual({});
    });
}
