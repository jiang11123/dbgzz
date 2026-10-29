import assert from "node:assert/strict";
import test from "node:test";

// Bun 直接执行 TypeScript 测试时需要保留扩展名；生产 tsconfig 不包含 test/。
import { DEFAULT_VIDEO_PROMPT_MAX_CHARS, defaultModelCapabilityConfig, modelCapabilityConfigFor, normalizeVideoValue, videoDurationAllowed } from "../src/lib/model-capabilities.ts";
import { modelCompatibilityError, modelPromptLengthError } from "../src/lib/model-selection.ts";
import type { AiConfig } from "../src/stores/use-config-store.ts";
import { seedanceTaskOptions, seedanceOmniTaskType } from "../src/lib/seedance-task-constraints.ts";

test("Dreamina native defaults expose editing and valid duration choices without expanding saved profiles", () => {
    const model = "dreamina-seedance-2-5-260628";
    const profile = defaultModelCapabilityConfig("volcengine-ark-video", model).video!;
    assert.ok(profile.operations.includes("inpaint") && profile.operations.includes("extend"));
    assert.ok(profile.ratios.includes("adaptive"));
    assert.equal(profile.duration.selection, "enum");
    assert.deepEqual(profile.duration.values, [-1, ...Array.from({ length: 27 }, (_, index) => index + 4)]);
    assert.deepEqual(defaultModelCapabilityConfig("volcengine-ark-video", "dreamina-seedance-2-0-fast-260128").video!.duration.values, [-1, ...Array.from({ length: 12 }, (_, index) => index + 4)]);
    for (const value of [-1, 4, 30]) assert.ok(videoDurationAllowed(profile, value));
    for (const value of [1, 3, 31]) assert.equal(videoDurationAllowed(profile, value), false);
    const config = { channels: [{ id: "custom", models: [model], modelProfiles: [{ model, protocol: "volcengine-ark-video" }] }] } as AiConfig;
    for (const operation of ["inpaint", "extend"]) assert.equal(modelCompatibilityError(config, `custom::${model}`, { capability: "video", videoSeconds: "6", videoOperation: operation as "inpaint" | "extend", input: { textCount: 1, imageCount: 0, characterCount: 0, videoCount: 1, audioCount: 0 } }), "");
    config.channels[0].modelProfiles![0].capabilityConfig = { version: 1, video: { ...profile, operations: ["text_to_video"], duration: { ...profile.duration, min: 5 }, ratios: ["16:9"] } };
    assert.deepEqual(modelCapabilityConfigFor(config, `custom::${model}`).video!.operations, ["text_to_video"]);
    assert.equal(modelCapabilityConfigFor(config, `custom::${model}`).video!.duration.min, 5);
    assert.deepEqual(modelCapabilityConfigFor(config, `custom::${model}`).video!.ratios, ["16:9"]);
    assert.equal(defaultModelCapabilityConfig("volcengine-ark-video", "doubao-seedance-2-5-260628").video!.duration.min, 1);
    assert.equal(defaultModelCapabilityConfig("newapi", model).video!.duration.min, 1);
});

test("Dreamina 2.5 enables audio-only and keeps edit and extension task constraints", () => {
    const model = "dreamina-seedance-2-5-260628";
    const video = defaultModelCapabilityConfig("volcengine-ark-video", model).video!;
    assert.equal(video.references.maxImages, 30);
    assert.equal(video.references.maxVideos, 10);
    assert.equal(video.references.maxAudios, 10);
    assert.equal(video.duration.max, 30);
    assert.ok(video.operations.includes("audio_to_video"));
    assert.deepEqual(seedanceTaskOptions(model, "16:9", 6, [], 1, "inpaint"), { ratio: "adaptive", duration: -1 });
    assert.equal(seedanceOmniTaskType(model, "extend", 1), "extend");
    assert.deepEqual(seedanceTaskOptions(model, "16:9", 6, ["first_frame"], 0), { ratio: "adaptive", duration: 6 });
});

test("Dreamina Fast and Mini restrict native defaults without changing standard or custom profiles", () => {
    for (const model of ["dreamina-seedance-2-0-fast-260128", "dreamina-seedance-2-0-mini-260615"]) {
        assert.deepEqual(defaultModelCapabilityConfig("volcengine-ark-video", model).video!.resolutions, ["480p", "720p"]);
        const config = { channels: [{ id: "custom", models: [model], modelProfiles: [{ model, protocol: "volcengine-ark-video", capabilityConfig: { version: 1, video: { ...defaultModelCapabilityConfig("volcengine-ark-video", model).video!, resolutions: ["720p"] } } }] }] } as AiConfig;
        assert.deepEqual(modelCapabilityConfigFor(config, `custom::${model}`).video!.resolutions, ["720p"]);
    }
    assert.deepEqual(defaultModelCapabilityConfig("volcengine-ark-video", "dreamina-seedance-2-0-260128").video!.resolutions, ["480p", "720p", "1080p"]);
});

test("FullVideo full models accept one or two image references as well as mixed video references", () => {
    for (const name of ["sd-native-full-2.0", "sd-native-full-2.5", "原生不卡人脸-全参2.0", "原生不卡人脸-全参2.5"]) {
        const config = { channels: [{ id: "fullvideo", baseUrl: "https://video.example.com/v1", models: [name], modelProfiles: [{ model: name, capability: "video", protocol: "full-video" }] }] } as AiConfig;
        for (const [imageCount, videoCount] of [[1, 0], [2, 0], [0, 1], [2, 1]]) {
            assert.equal(modelCompatibilityError(config, `fullvideo::${name}`, {
                capability: "video", videoSeconds: "5",
                input: { textCount: 1, imageCount, videoCount, audioCount: 0, characterCount: 0 },
            }), "");
        }
    }
});

test("switching to MiniMax H3 replaces an unsupported 720p value with 768P", () => {
    const profile = defaultModelCapabilityConfig("minimax-video", "MiniMax-H3").video!;

    assert.deepEqual(normalizeVideoValue(profile, { seconds: "11", ratio: "16:9", resolution: "720" }), {
        seconds: "11",
        ratio: "16:9",
        resolution: "768P",
    });
});

test("undocumented video prompt ceilings are left to the provider", () => {
    assert.equal(DEFAULT_VIDEO_PROMPT_MAX_CHARS, 0);
    for (const protocol of [undefined, "seedance-videos-compatible", "agnes-video", "volcengine-ark-video"]) {
        const profile = defaultModelCapabilityConfig(protocol, "test-model");
        assert.equal(profile.video!.references.promptMaxChars, DEFAULT_VIDEO_PROMPT_MAX_CHARS);
    }
});

test("raising the video default leaves text and image limits untouched", () => {
    // 只放宽视频默认值，避免顺带改变其它能力的判定口径。
    const profile = defaultModelCapabilityConfig("seedance-videos-compatible", "sd-2.5");
    assert.equal(profile.text!.references.promptMaxChars, 32000);
    assert.equal(profile.image!.references.promptMaxChars, 32000);
});

test("Seedance does not infer a native ceiling from a shared tool schema", () => {
    for (const model of ["seedance-2.0", "seedance-2.0-fast", "doubao-seedance-2-0-260128"]) {
        assert.equal(defaultModelCapabilityConfig("newapi", model).video!.references.promptMaxChars, 0);
    }
    assert.equal(defaultModelCapabilityConfig("newapi", "other-video").video!.references.promptMaxChars, 0);
});

test("a refreshed Seedance catalog removes the generic cap but preserves explicit channel limits", () => {
    const model = "seedance-2.0";
    const capabilityConfig = defaultModelCapabilityConfig("newapi", model);
    const config = { channels: [{ id: "official", name: "official", baseUrl: "https://enterprise.beefapi.com", apiKey: "test", apiFormat: "openai", models: [model], modelProfiles: [{ model, protocol: "newapi", capability: "video", capabilityConfig }] }] } as AiConfig;
    assert.equal(modelPromptLengthError(config, `official::${model}`, "video", "镜".repeat(8101)), "");
    assert.equal(modelPromptLengthError(config, `official::${model}`, "video", "镜".repeat(32000)), "");
    assert.equal(modelPromptLengthError(config, `official::${model}`, "video", "镜".repeat(32001)), "");
    capabilityConfig.video!.references.promptMaxChars = 4096;
    assert.match(modelPromptLengthError(config, `official::${model}`, "video", "镜".repeat(4097)), /4096/);
});

test("documented prompt contracts are specific to the provider endpoint", () => {
    for (const [protocol, model, chars] of [
        ["minimax-video", "MiniMax-H3", 7000],
        ["minimax-video", "MiniMax-Hailuo-2.3", 0],
        ["dashscope-wan-video", "wan2.1-t2v-turbo", 800],
        ["dashscope-wan-video", "wan2.6-i2v", 1500],
        ["dashscope-wan-video", "wan2.7-r2v", 5000],
        ["dashscope-wan-video", "wan3.0-t2v", 20000],
        ["openai-videos", "sora-2-pro", 32000],
        ["full-video", "sd-native-full-2.0", 4000],
        ["kling-video", "kling-v3", 0],
        ["luma-dream-machine", "ray-2", 5000],
        ["pixverse-video", "v6-max", 5000],
        ["zhipu-cogvideox", "cogvideox-3", 512],
        ["volcengine-jimeng-video", "jimeng_t2v_v30", 800],
        ["gemini-veo", "veo-3.1-generate-preview", 0],
        ["newapi", "MiniMax-H3", 0],
        ["custom-workflow", "wan3.0-t2v", 0],
    ] as const) {
        assert.equal(defaultModelCapabilityConfig(protocol, model).video!.references.promptMaxChars, chars, `${protocol}/${model}`);
    }
});

test("Runway UTF-16 limits count astral characters consistently with the provider", () => {
    const model = "gen4_turbo";
    const capabilityConfig = defaultModelCapabilityConfig("runway-video", model);
    const config = { channels: [{ id: "runway", models: [model], modelProfiles: [{ model, protocol: "runway-video", capabilityConfig }] }] } as AiConfig;
    assert.equal(modelPromptLengthError(config, `runway::${model}`, "video", "😀".repeat(500)), "");
    assert.match(modelPromptLengthError(config, `runway::${model}`, "video", "😀".repeat(501)), /1002.*UTF-16/);
    assert.equal(modelPromptLengthError(config, `runway::${model}`, "video", "中".repeat(1000)), "");
    assert.match(modelPromptLengthError(config, `runway::${model}`, "video", "中".repeat(1001)), /1001/);
});

test("persisted video prompt limits do not inherit new UTF-16 defaults after reload", () => {
    const model = "gen4_turbo";
    assert.equal(defaultModelCapabilityConfig("runway-video", model).video!.references.promptMaxUtf16Units, 1000);
    for (const chars of [8000, 0]) {
        for (const utf16Units of [undefined, 0]) {
            const capabilityConfig = defaultModelCapabilityConfig("runway-video", model);
            capabilityConfig.video!.references.promptMaxChars = chars;
            if (utf16Units === undefined) delete capabilityConfig.video!.references.promptMaxUtf16Units;
            else capabilityConfig.video!.references.promptMaxUtf16Units = utf16Units;
            const persisted = JSON.stringify({ channels: [{ id: "runway", models: [model], modelProfiles: [{ model, protocol: "runway-video", capabilityConfig }] }] });
            const reloaded = JSON.parse(persisted) as AiConfig;
            const resolved = modelCapabilityConfigFor(reloaded, `runway::${model}`).video!;
            assert.equal(resolved.references.promptMaxChars, chars);
            assert.equal(resolved.references.promptMaxUtf16Units, 0);
            assert.equal(modelPromptLengthError(reloaded, `runway::${model}`, "video", "😀".repeat(1001)), "");
            assert.equal(modelPromptLengthError(reloaded, `runway::${model}`, "video", "镜".repeat(8000)), "");
            if (chars === 8000) assert.match(modelPromptLengthError(reloaded, `runway::${model}`, "video", "镜".repeat(8001)), /8000/);
            else assert.equal(modelPromptLengthError(reloaded, `runway::${model}`, "video", "镜".repeat(8001)), "");
            assert.equal(JSON.stringify(reloaded), persisted, "resolving saved limits must not mutate the profile");
        }
    }
});

test("APIMart NewAPI channel exposes Seedance multimodal reference operations", () => {
    const profile = defaultModelCapabilityConfig("newapi-channel-2", "seedance-2.0-fast").video!;
    assert.deepEqual(profile.references.maxVideos, 3);
    assert.ok(profile.operations.includes("reference_to_video"));
    assert.ok(!profile.operations.includes("audio_to_video"));
});

test("BeefAPI generic newapi Seedance accepts mixed image and video references without a persisted capability profile", () => {
    const model = "beefapi::seedance-2.0-fast";
    const config = {
        channels: [{
            id: "beefapi",
            name: "BeefAPI",
            baseUrl: "https://enterprise.beefapi.com",
            apiKey: "test",
            apiFormat: "openai",
            models: ["seedance-2.0-fast"],
            modelProfiles: [{
                model: "seedance-2.0-fast",
                capability: "video",
                protocol: "newapi",
                billingMode: "fixed_request",
                unitPriceMicrocredits: 0,
            }],
        }],
    } as AiConfig;

    const profile = modelCapabilityConfigFor(config, model).video!;
    assert.ok(profile.operations.includes("reference_to_video"));
    assert.ok(profile.references.maxVideos >= 1);
    assert.equal(modelCompatibilityError(config, model, {
        capability: "video",
        input: { textCount: 1, imageCount: 1, videoCount: 1, audioCount: 0, characterCount: 0 },
        videoSeconds: "5",
    }), "");
});
