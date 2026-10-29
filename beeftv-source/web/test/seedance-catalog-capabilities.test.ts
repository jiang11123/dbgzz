import { expect, test } from "bun:test";
import axios from "axios";

import { mergeFetchedChannelModelProfiles, sanitizeChannelModelCatalogItem } from "../src/lib/channel-model-catalog";
import { modelCapabilityConfigFor, sanitizeServerVideoCapability, type VideoCapabilityConfig } from "../src/lib/model-capabilities";
import { applyFetchedChannelModelCatalog, mergeManagedBeefAPICatalog } from "../src/pages/settings/channel-settings-pane";
import { modelCompatibilityError, portraitGenerationError } from "../src/lib/model-selection";
import { fetchChannelModels } from "../src/services/api/image-models";
import { assertVideoCapability } from "../src/services/api/video-validation";
import { createModelChannel, defaultConfig, normalizeConfigSnapshot } from "../src/stores/use-config-store";

function sampleVideo(maxVideos: number, maxAudios: number): VideoCapabilityConfig {
    return {
        references: {
            promptMaxChars: 8000,
            minImages: 0,
            maxImages: 9,
            maxImageBytes: 1,
            maxVideos,
            maxVideoBytes: 1,
            maxVideoDurationSeconds: 15,
            maxAudios,
            maxAudioBytes: 1,
            maxAudioDurationSeconds: 15,
        },
        duration: { selection: "range", min: 1, max: 15, step: 1, default: 6 },
        ratios: ["16:9"],
        defaultRatio: "16:9",
        resolutions: ["720p"],
        defaultResolution: "720p",
        generateAudio: { supported: true, default: true },
        watermark: { supported: false, default: false },
        operations: ["text_to_video", "image_to_video", "reference_to_video"],
        defaultOperation: "text_to_video",
    };
}

function legacyZeroVideo(model: string) {
    const capabilityConfig = {
        version: 1,
        video: {
            ...sampleVideo(0, 0),
            operations: ["text_to_video", "image_to_video"],
            defaultOperation: "text_to_video",
            references: {
                ...sampleVideo(0, 0).references,
                maxImages: 9,
                maxVideos: 0,
                maxAudios: 0,
                maxVideoBytes: 200 * 1024 * 1024,
                maxAudioBytes: 15 * 1024 * 1024,
                maxVideoDurationSeconds: 0,
                maxAudioDurationSeconds: 0,
            },
        },
    };
    return createModelChannel({
        id: "beefapi",
        baseUrl: "https://enterprise.beefapi.com",
        models: [model],
        modelProfiles: [{ model, capability: "video", protocol: "newapi", capabilityConfig }],
    });
}

test("fresh generic OpenAI catalog entries retain real portrait quotes through refresh and reload", () => {
    const channel = createModelChannel({ id: "beefapi", baseUrl: "https://enterprise.beefapi.com", models: ["seedance-2.0-fast"] });
    const catalog = ["seedance-2.0-portrait", "seedance-2.5-portrait", "seedance-2.0-fast"].map((id, index) => ({
        id,
        // Actual gateway shape: video contract and quote, no modelType.
        supportedEndpointTypes: ["openai"],
        videoCapabilities: sampleVideo(3, 3),
        videoCapabilitiesVersion: `catalog-${index}`,
        videoPricing: { currency: "CNY" as const, mode: "tokens" as const, rates: { "720p": { output: 69 + index, reference_video: 42 + index } } },
    }));
    const refreshed = applyFetchedChannelModelCatalog(channel, { models: catalog.map((item) => item.id), catalog });
    const reloaded = normalizeConfigSnapshot(JSON.parse(JSON.stringify({ config: { ...defaultConfig, channels: [refreshed] } }))).config;
    for (const item of catalog) {
        const profile = reloaded.channels[0]!.modelProfiles!.find((profile) => profile.model === item.id)!;
        expect(profile.capability).toBe("video");
        expect(profile.protocol).toBe("newapi");
        expect(profile.videoPricing).toEqual(item.videoPricing);
        expect(profile.videoCapabilitiesVersion).toBe(item.videoCapabilitiesVersion);
        expect(modelCompatibilityError(reloaded, `beefapi::${item.id}`, { capability: "video", input: { textCount: 1, imageCount: 1, videoCount: 0, audioCount: 0, characterCount: 0 } })).toBe("");
        expect(portraitGenerationError(reloaded, `beefapi::${item.id}`, "720p")).toBe("");
    }
    const missingPrice = applyFetchedChannelModelCatalog(refreshed, { models: catalog.map((item) => item.id), catalog: catalog.map((item) => ({ ...item, videoPricing: null })) });
    const unavailable = normalizeConfigSnapshot({ config: { ...defaultConfig, channels: [missingPrice] } }).config;
    expect(portraitGenerationError(unavailable, "beefapi::seedance-2.0-portrait")).toContain("价格暂不可用");
    expect(portraitGenerationError(unavailable, "beefapi::seedance-2.5-portrait")).toContain("价格暂不可用");
    expect(portraitGenerationError(unavailable, "beefapi::seedance-2.0-fast")).toBe("");
});

test("generic endpoints and prices alone do not classify an unknown catalog model as video", () => {
    const channel = createModelChannel({ id: "beefapi", baseUrl: "https://enterprise.beefapi.com", models: [] });
    expect(mergeFetchedChannelModelProfiles(channel, [{ id: "unknown-upstream-model", supportedEndpointTypes: ["openai"], videoPricing: { currency: "CNY", mode: "tokens", rates: { "720p": { output: 69, reference_video: 42 } } } }])).toEqual([]);
});

test("catalog import stores managed video capabilities and version", () => {
    const channel = createModelChannel({ id: "beefapi", baseUrl: "https://enterprise.beefapi.com", models: ["seedance-2.0"] });
    const video = sampleVideo(2, 1);
    const profiles = mergeFetchedChannelModelProfiles(channel, [{ id: "seedance-2.0", modelType: "video", videoCapabilities: video, videoCapabilitiesVersion: "cap-v1" }]);
    expect(profiles[0]?.videoCapabilitiesVersion).toBe("cap-v1");
    expect(profiles[0]?.capabilityConfig?.video?.references.maxVideos).toBe(2);
    expect(profiles[0]?.capabilityConfig?.video?.references.maxAudios).toBe(1);
});

test("catalog zero prompt ceiling and UTF-16 limit survive import and reload", () => {
    const video = sampleVideo(0, 0);
    video.references.promptMaxChars = 0;
    video.references.promptMaxUtf16Units = 1000;
    const channel = createModelChannel({ id: "beefapi", baseUrl: "https://enterprise.beefapi.com", models: ["gen4_turbo"] });
    const profiles = mergeFetchedChannelModelProfiles(channel, [{ id: "gen4_turbo", modelType: "video", videoCapabilities: video, videoCapabilitiesVersion: "utf16-v1" }]);
    const config = normalizeConfigSnapshot({ config: { ...defaultConfig, channels: [{ ...channel, modelProfiles: profiles }] } }).config;
    const references = modelCapabilityConfigFor(config, "beefapi::gen4_turbo").video!.references;
    expect(references.promptMaxChars).toBe(0);
    expect(references.promptMaxUtf16Units).toBe(1000);
});

test("refresh replaces managed capabilities and keeps the new version", () => {
    const channel = createModelChannel({
        id: "beefapi",
        baseUrl: "https://enterprise.beefapi.com",
        models: ["seedance-2.0"],
        modelProfiles: [{ model: "seedance-2.0", capability: "video", protocol: "newapi", capabilityConfig: { version: 1, video: sampleVideo(3, 3) }, videoCapabilitiesVersion: "v1" }],
    });
    const profiles = mergeFetchedChannelModelProfiles(channel, [{ id: "seedance-2.0", modelType: "video", videoCapabilities: sampleVideo(0, 1), videoCapabilitiesVersion: "v2" }]);
    expect(profiles[0]?.videoCapabilitiesVersion).toBe("v2");
    expect(profiles[0]?.capabilityConfig?.video?.references.maxVideos).toBe(0);
    expect(profiles[0]?.capabilityConfig?.video?.references.maxAudios).toBe(1);
});

test("explicit zero limits stay zero for a server-sourced BeefAPI capability", () => {
    const model = "seedance-2.0";
    const capabilityConfig = {
        version: 1,
        video: {
            ...sampleVideo(0, 0),
            operations: ["text_to_video", "image_to_video"],
            references: {
                ...sampleVideo(0, 0).references,
                maxImages: 9,
                maxVideoBytes: 200 * 1024 * 1024,
                maxAudioBytes: 15 * 1024 * 1024,
                maxVideoDurationSeconds: 0,
                maxAudioDurationSeconds: 0,
            },
        },
    };
    const channel = createModelChannel({
        id: "beefapi",
        baseUrl: "https://enterprise.beefapi.com",
        models: [model],
        modelProfiles: [{ model, capability: "video", protocol: "newapi", capabilityConfig, videoCapabilitiesVersion: "cap-v1" }],
    });
    const config = normalizeConfigSnapshot({ config: { ...defaultConfig, channels: [channel] } }).config;
    const profile = config.channels[0]?.modelProfiles?.find((item) => item.model === model);
    expect(profile?.videoCapabilitiesVersion).toBe("cap-v1");
    expect(modelCapabilityConfigFor(config, `beefapi::${model}`).video!.references.maxVideos).toBe(0);
    expect(modelCapabilityConfigFor(config, `beefapi::${model}`).video!.references.maxAudios).toBe(0);
});

test("legacy BeefAPI Seedance still repairs unsigned zero catalogs", () => {
    const model = "seedance-2.0";
    const config = normalizeConfigSnapshot({ config: { ...defaultConfig, channels: [legacyZeroVideo(model)] } }).config;
    expect(config.channels[0]?.modelProfiles?.[0]?.videoCapabilitiesVersion).toBeUndefined();
    expect(modelCapabilityConfigFor(config, `beefapi::${model}`).video!.references.maxVideos).toBe(3);
    expect(modelCapabilityConfigFor(config, `beefapi::${model}`).video!.references.maxAudios).toBe(3);
});

test("invalid or missing catalog video does not clear a good sourced profile", () => {
    const channel = createModelChannel({
        id: "beefapi",
        baseUrl: "https://enterprise.beefapi.com",
        models: ["seedance-2.0"],
        modelProfiles: [{ model: "seedance-2.0", capability: "video", protocol: "newapi", capabilityConfig: { version: 1, video: sampleVideo(2, 2) }, videoCapabilitiesVersion: "keep" }],
    });
    const overlay = { defaultParameters: { durationSeconds: "8" }, options: { durationSeconds: [{ value: "8" }] } };
    const invalid = mergeFetchedChannelModelProfiles(channel, [{ id: "seedance-2.0", modelType: "video", videoCapabilities: { operations: [] } as never, videoCapabilitiesVersion: "bad", ...overlay }]);
    expect(invalid[0]?.videoCapabilitiesVersion).toBe("keep");
    expect(invalid[0]?.capabilityConfig?.video?.references.maxVideos).toBe(2);
    expect(invalid[0]?.capabilityConfig?.video?.duration).toEqual(sampleVideo(2, 2).duration);
    const missing = mergeFetchedChannelModelProfiles(channel, [{ id: "seedance-2.0", modelType: "video", ...overlay }]);
    expect(missing[0]?.videoCapabilitiesVersion).toBe("keep");
    expect(missing[0]?.capabilityConfig?.video?.references.maxVideos).toBe(2);
    expect(missing[0]?.capabilityConfig?.video?.duration).toEqual(sampleVideo(2, 2).duration);
});

test("custom channels ignore catalog video capabilities", () => {
    const capabilityConfig = { version: 1, video: sampleVideo(1, 0) };
    const channel = createModelChannel({
        id: "custom",
        baseUrl: "https://example.com",
        models: ["seedance-2.0"],
        modelProfiles: [{ model: "seedance-2.0", capability: "video", protocol: "newapi", capabilityConfig }],
    });
    const profiles = mergeFetchedChannelModelProfiles(channel, [{ id: "seedance-2.0", modelType: "video", videoCapabilities: sampleVideo(9, 9), videoCapabilitiesVersion: "ignore-me" }]);
    expect(profiles[0]?.videoCapabilitiesVersion).toBeUndefined();
    expect(profiles[0]?.capabilityConfig?.video?.references.maxVideos).toBe(1);
    expect(profiles[0]?.capabilityConfig?.video?.references.maxAudios).toBe(0);
});

test("mergeManagedBeefAPICatalog copies sourced capabilities from the backend snapshot", () => {
    const current = { ...defaultConfig, channels: [createModelChannel({ id: "beefapi", pinned: true, models: ["stale"] })] };
    const server = {
        ...defaultConfig,
        channels: [
            createModelChannel({
                id: "beefapi",
                pinned: true,
                models: ["seedance-2.0"],
                modelProfiles: [{ model: "seedance-2.0", capability: "video", protocol: "newapi", capabilityConfig: { version: 1, video: sampleVideo(0, 0) }, videoCapabilitiesVersion: "from-server" }],
            }),
        ],
    };
    const merged = mergeManagedBeefAPICatalog(current, server);
    const profile = merged.channels.find((channel) => channel.id === "beefapi")?.modelProfiles?.[0];
    expect(profile?.videoCapabilitiesVersion).toBe("from-server");
    expect(profile?.capabilityConfig?.video?.references.maxVideos).toBe(0);
});

test("sanitizeServerVideoCapability rejects non-finite values and keeps omitted nested limits omitted", () => {
    expect(sanitizeServerVideoCapability(sampleVideo(0, 0))?.references.maxVideos).toBe(0);
    expect(sanitizeServerVideoCapability({ ...sampleVideo(3, 1), references: { maxVideos: Number.POSITIVE_INFINITY } })).toBeNull();
    const partial = sanitizeServerVideoCapability({
        references: { maxVideos: 0 },
        duration: { selection: "enum", values: [5], default: 5 },
        ratios: ["16:9"],
        defaultRatio: "16:9",
        resolutions: [],
        defaultResolution: "",
        generateAudio: { supported: false, default: false },
        watermark: { supported: false, default: false },
        operations: ["text_to_video"],
        defaultOperation: "text_to_video",
    });
    expect(partial?.references.maxVideos).toBe(0);
    expect(partial?.references.maxAudios).toBeUndefined();
});

test("native Ark Seedance 2.x uses the documented 407696 pixel floor", () => {
    const profile = modelCapabilityConfigFor(
        { channels: [{ id: "ark", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", models: ["seedance-2.0"], modelProfiles: [{ model: "seedance-2.0", protocol: "volcengine-ark-video" }] }] },
        "ark::seedance-2.0",
    ).video!;
    expect(profile.references.minVideoPixels).toBe(407696);
    const video = (width: number, height: number) => ({ id: "vid", name: "视频", type: "video/mp4", url: "https://example.com/v.mp4", width, height, durationMs: 3000, bytes: 1 });
    expect(() => assertVideoCapability(profile, [], [video(720, 567)], [], "5")).not.toThrow();
    expect(() => assertVideoCapability(profile, [], [video(720, 566)], [], "5")).toThrow("407696");
});

test("custom pixel restrictions stay in place for non-Ark channels", () => {
    const capabilityConfig = { version: 1, video: { ...sampleVideo(3, 3), references: { ...sampleVideo(3, 3).references, minVideoPixels: 500000, maxVideoPixels: 8295044, minVideoDurationSeconds: 2 } } };
    const profile = modelCapabilityConfigFor(
        { channels: [{ id: "custom", baseUrl: "https://example.com", models: ["seedance-2.0"], modelProfiles: [{ model: "seedance-2.0", protocol: "newapi", capabilityConfig }] }] },
        "custom::seedance-2.0",
    ).video!;
    expect(profile.references.minVideoPixels).toBe(500000);
    const video = (width: number, height: number) => ({ id: "vid", name: "视频", type: "video/mp4", url: "https://example.com/v.mp4", width, height, durationMs: 3000, bytes: 1 });
    expect(() => assertVideoCapability(profile, [], [video(720, 700)], [], "5")).not.toThrow();
    expect(() => assertVideoCapability(profile, [], [video(720, 694)], [], "5")).toThrow("500000");
});

test("direct OpenAI catalog fetch keeps BeefAPI video capability fields", async () => {
    const original = axios.request;
    axios.request = (async () => ({
        data: {
            data: [
                {
                    id: "seedance-2.0",
                    display_name: "Seedance",
                    model_type: "video",
                    supported_endpoint_types: ["openai-video"],
                    video_capabilities: sampleVideo(0, 0),
                    video_capabilities_version: "wire-v1",
                },
            ],
        },
    })) as typeof axios.request;
    try {
        const result = await fetchChannelModels(createModelChannel({ baseUrl: "https://provider.example", apiKey: "synthetic-test-key", models: [] }));
        const item = sanitizeChannelModelCatalogItem(result.catalog[0]);
        expect(item?.videoCapabilitiesVersion).toBe("wire-v1");
        expect(item?.videoCapabilities?.references.maxVideos).toBe(0);
    } finally {
        axios.request = original;
    }
});

test("Auto duration survives shared normalization and config hydration", async () => {
    const { normalizeVideoDuration } = await import("../src/lib/video-generation-options");
    const { normalizeVideoSeconds } = await import("../src/services/api/video-validation");
    const { videoSecondsLabel } = await import("../src/components/video-settings-panel");
    expect(normalizeVideoDuration(-1)).toBe("-1");
    expect(normalizeVideoSeconds("-1")).toBe("-1");
    expect(videoSecondsLabel("-1")).toBe("自动");
    expect(normalizeConfigSnapshot({ config: { ...defaultConfig, videoSeconds: "-1" } }).config.videoSeconds).toBe("-1");
    expect(normalizeVideoSeconds("5")).toBe("5");
    expect(normalizeVideoSeconds("-2")).toBe("1");
});

test("Auto duration reaches canvas model selection and final generation unchanged", async () => {
    const { buildGenerationConfig } = await import("../src/lib/canvas/canvas-project-generation");
    const video = sampleVideo(3, 3);
    video.duration = { selection: "enum", values: [-1, 4, 5], default: 4 };
    const channel = legacyZeroVideo("seedance-2.0");
    channel.modelProfiles = mergeFetchedChannelModelProfiles(channel, [{
        id: "seedance-2.0", modelType: "video",
        videoCapabilities: video, videoCapabilitiesVersion: "auto-v1",
    }]);
    const model = "beefapi::seedance-2.0";
    const config = { ...defaultConfig, channels: [channel], models: [model], videoModels: [model], model, videoModel: model, videoSeconds: "-1", size: "16:9", vquality: "720" };
    const { CanvasNodeType } = await import("../src/types/canvas");
    const result = buildGenerationConfig(config, { id: "auto", type: CanvasNodeType.Video, title: "Auto", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { model, seconds: "-1" } }, "video");
    expect(result.model).toBe(model);
    expect(result.videoSeconds).toBe("-1");
});
