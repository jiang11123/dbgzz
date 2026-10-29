import { expect, test } from "bun:test";
import { beefAPIVideoContract, isBeefAPIEndpoint } from "../src/lib/beefapi-video-contracts";
import { createModelChannel, defaultConfig, normalizeConfigSnapshot, resolveModelRequestConfig } from "../src/stores/use-config-store";
import { defaultModelCapabilityConfig, modelCapabilityConfigFor } from "../src/lib/model-capabilities";
import { createVideoGenerationsTask } from "../src/services/api/video-provider-newapi";
import { createVideoTransport } from "../src/services/api/video-transport";
import { videoResponseTools } from "../src/services/api/video-response";
import { buildGenerationConfig } from "../src/lib/canvas/canvas-generation-config";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";
import { backendProviderConfig } from "../src/services/api/generation-task";

test("Kling capability repair preserves profile defaults and explicit canvas audio choices through task config", () => {
    const model = "kling-video-v3";
    for (const audioDefault of [false, true]) {
        const capabilityConfig = defaultModelCapabilityConfig("newapi", model);
        capabilityConfig.video!.generateAudio = { supported: false, default: audioDefault };
        const channel = createModelChannel({ id: "beefapi", baseUrl: "https://beeftv.app", models: [model], modelProfiles: [{ model, capability: "video", protocol: "newapi", capabilityConfig }] });
        const snapshot = normalizeConfigSnapshot({ config: { ...defaultConfig, channels: [channel], videoModel: `beefapi::${model}`, videoGenerateAudio: String(!audioDefault) } }).config;
        expect(modelCapabilityConfigFor(snapshot, `beefapi::${model}`).video!.generateAudio).toEqual({ supported: true, default: audioDefault });
        for (const selected of [undefined, "false", "true"] as const) {
            const node: CanvasNodeData = { id: "video", type: CanvasNodeType.Video, title: "fixture", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { model: `beefapi::${model}`, generateAudio: selected } };
            const config = resolveModelRequestConfig(buildGenerationConfig(snapshot, node, "video"), `beefapi::${model}`);
            const expected = selected === undefined ? audioDefault : selected === "true";
            expect(config.videoGenerateAudio).toBe(String(expected));
            expect(backendProviderConfig(config, "video")).toMatchObject({ videoGenerateAudio: String(expected), videoSeconds: "5", model });
        }
    }
});

test("Seedance repaired catalog exposes audio control and sends explicit false", async () => {
    const model = "seedance-2.0-fast";
    const channel = createModelChannel({id: "beefapi", baseUrl: "https://enterprise.beefapi.com", models: [model], modelProfiles: [{model, capability: "text", protocol: "chat-completion"}]});
    const snapshot = normalizeConfigSnapshot({config: {...defaultConfig, channels: [channel], videoGenerateAudio: "false"}}).config;
    const config = resolveModelRequestConfig(snapshot, `beefapi::${model}`);
    expect(modelCapabilityConfigFor(snapshot, `beefapi::${model}`).video!.generateAudio.supported).toBe(true);
    const calls: unknown[] = [];
    const deps = {response: videoResponseTools, transport: {...createVideoTransport(config), post: async <T>(_url: string, body: unknown) => { calls.push(body); return {id: "test-seedance", status: "queued"} as T; }}};
    await createVideoGenerationsTask(deps, config, model, "test", [], [], []);
    expect(calls[0]).toMatchObject({generate_audio: false});
    expect(defaultModelCapabilityConfig("newapi", "other-video").video!.generateAudio.supported).toBe(false);
});

test("Wan uses shared protocol and supported reference limits across reloads", () => {
    const model = "wan3.0-video";
    const channel = createModelChannel({id: "beefapi", baseUrl: "https://enterprise.beefapi.com", models: [model], modelProfiles: [{model, capability: "video", protocol: "openai-videos"}]});
    let config = {...defaultConfig, channels: [channel]};
    for (let i = 0; i < 2; i++) {
        config = normalizeConfigSnapshot({config}).config;
        expect(resolveModelRequestConfig(config, `beefapi::${model}`).interfaceType).toBe("newapi-channel-2");
        const refs = modelCapabilityConfigFor(config, `beefapi::${model}`).video!.references;
        expect([refs.maxImages, refs.maxVideos, refs.maxAudios]).toEqual([1, 0, 0]);
    }
});

test("saved BeefAPI Seedance profiles restore audio control without changing explicit defaults or custom endpoints", async () => {
    const model = "seedance-2.0-fast";
    for (const legacy of [false, true]) {
        for (const baseUrl of ["https://beeftv.app", "https://enterprise.beefapi.com", "https://custom.example"]) {
            const capabilityConfig = defaultModelCapabilityConfig("newapi", model);
            capabilityConfig.video!.generateAudio = {supported: false, default: false};
            capabilityConfig.video!.references.maxImages = legacy ? 9 : 2;
            if (legacy) {
                capabilityConfig.video!.operations = ["text_to_video", "image_to_video"];
                Object.assign(capabilityConfig.video!.references, {maxVideos: 0, maxAudios: 0, maxVideoDurationSeconds: 0, maxAudioDurationSeconds: 0, maxVideoBytes: 200 * 1024 * 1024, maxAudioBytes: 15 * 1024 * 1024});
            }
            const channel = createModelChannel({id: "saved", baseUrl, models: [model], modelProfiles: [{model, capability: "video", protocol: "newapi", capabilityConfig}]});
            let snapshot = {...defaultConfig, channels: [channel], videoGenerateAudio: "false"};
            for (let reload = 0; reload < 2; reload++) snapshot = normalizeConfigSnapshot({config: snapshot}).config;
            const profile = modelCapabilityConfigFor(snapshot, `saved::${model}`).video!;
            expect(profile.generateAudio).toEqual({supported: isBeefAPIEndpoint(baseUrl), default: false});
            expect(profile.references.maxImages).toBe(legacy ? 9 : 2);
            if (!isBeefAPIEndpoint(baseUrl)) continue;
            const config = resolveModelRequestConfig(snapshot, `saved::${model}`);
            const calls: unknown[] = [];
            const deps = {response: videoResponseTools, transport: {...createVideoTransport(config), post: async <T>(_url: string, body: unknown) => { calls.push(body); return {id: "saved", status: "queued"} as T; }}};
            await createVideoGenerationsTask(deps, config, model, "test", [], [], []);
            expect(calls[0]).toMatchObject({generate_audio: false});
        }
    }
});

test("new models preserve their catalog protocol without inheriting unverified inline support", () => {
    const model = "future-video";
    const channel = createModelChannel({id: "beefapi", baseUrl: "https://enterprise.beefapi.com", models: [model], modelProfiles: [{model, capability: "video", protocol: "minimax-video"}]});
    const config = normalizeConfigSnapshot({config: {...defaultConfig, channels: [channel]}}).config;
    expect(resolveModelRequestConfig(config, `beefapi::${model}`).interfaceType).toBe("minimax-video");
    expect(beefAPIVideoContract(model)).toBeUndefined();
    expect(beefAPIVideoContract("wan3.0-video-prime")).toBeUndefined();
});

test("saved BeefAPI grok video profile never keeps a text protocol", () => {
    const model = "grok-imagine-video-1.5";
    for (const savedCapability of ["text", "video"] as const) {
        const channel = createModelChannel({id: "beefapi", baseUrl: "https://enterprise.beefapi.com", models: [model], modelProfiles: [{model, capability: savedCapability, protocol: "chat-completion"}]});
        const config = normalizeConfigSnapshot({config: {...defaultConfig, channels: [channel]}}).config;
        const profile = config.channels[0]!.modelProfiles!.find((item) => item.model === model)!;
        expect(profile.capability).toBe("video");
        expect(profile.protocol).toBe("newapi");
        expect(resolveModelRequestConfig(config, `beefapi::${model}`).interfaceType).toBe("newapi");
    }
});

test("saved BeefAPI Seedance profiles still follow the shared video contract", () => {
    const model = "seedance-2.0-fast";
    const channel = createModelChannel({id: "beefapi", baseUrl: "https://enterprise.beefapi.com", models: [model], modelProfiles: [{model, capability: "text", protocol: "chat-completion"}]});
    const config = normalizeConfigSnapshot({config: {...defaultConfig, channels: [channel]}}).config;
    const profile = config.channels[0]!.modelProfiles!.find((item) => item.model === model)!;
    expect(profile.capability).toBe("video");
    expect(profile.protocol).toBe("newapi");
    expect(resolveModelRequestConfig(config, `beefapi::${model}`).interfaceType).toBe("newapi");
});

test("media contract overrides require the exact enterprise HTTPS endpoint", () => {
    for (const base of ["https://enterprise.beefapi.com.evil.test", "https://evil.test/enterprise.beefapi.com", "http://enterprise.beefapi.com", "https://user@enterprise.beefapi.com", "https://enterprise.beefapi.com:444"]) expect(isBeefAPIEndpoint(base)).toBe(false);
    expect(isBeefAPIEndpoint("https://enterprise.beefapi.com/v1")).toBe(true);
});

test("partial reference contracts preserve the limits of unspecified media kinds", () => {
    const model = "wan3.0-video";
    const contract = beefAPIVideoContract(model)!;
    const original = contract.maxReferences;
    try {
        contract.maxReferences = {image: 1};
        const capabilityConfig = defaultModelCapabilityConfig("newapi-channel-2", model);
        Object.assign(capabilityConfig.video!.references, {maxImages: 4, maxVideos: 2, maxAudios: 1});
        const channel = createModelChannel({id: "beefapi", baseUrl: "https://enterprise.beefapi.com", models: [model], modelProfiles: [{model, capability: "video", protocol: "newapi-channel-2", capabilityConfig}]});
        const config = normalizeConfigSnapshot({config: {...defaultConfig, channels: [channel]}}).config;
        const refs = modelCapabilityConfigFor(config, `beefapi::${model}`).video!.references;
        expect([refs.maxImages, refs.maxVideos, refs.maxAudios]).toEqual([1, 2, 1]);
    } finally { contract.maxReferences = original; }
});

test("direct Wan transport requires HTTP references and rejects inline media before sending", async () => {
    const model = "wan3.0-video";
    const channel = createModelChannel({id: "beefapi", baseUrl: "https://enterprise.beefapi.com", models: [model]});
    const snapshot = normalizeConfigSnapshot({config: {...defaultConfig, channels: [channel]}}).config;
    const config = resolveModelRequestConfig(snapshot, `beefapi::${model}`);
    const calls: unknown[] = [];
    const deps = {response: videoResponseTools, transport: {...createVideoTransport(config), post: async <T>(url: string, body: unknown) => { calls.push({url, body}); return {id: "test-wan", status: "queued"} as T; }}};
    const image = {id: "image-1", name: "test.png", type: "image/png", dataUrl: "data:image/png;base64,dGVzdA=="};
    expect(beefAPIVideoContract(model)).toMatchObject({inlineMedia: false, requiresHTTPReferences: true});
    await expect(createVideoGenerationsTask(deps, config, model, "test", [image], [], [])).rejects.toThrow("公网 URL");
    expect(calls).toHaveLength(0);
    const task = await createVideoGenerationsTask(deps, config, model, "test", [{...image, url: "https://media.example/uploaded.png"}], [], []);
    expect(task.id).toBe("test-wan");
    expect(calls[0]).toMatchObject({body: {image_urls: ["https://media.example/uploaded.png"]}});
    await expect(createVideoGenerationsTask(deps, config, model, "test", [image, image], [], [])).rejects.toThrow("最多支持 1");
    expect(calls).toHaveLength(1);
    await expect(createVideoGenerationsTask(deps, {...config, baseUrl: "https://other.example"}, model, "test", [image], [], [])).rejects.toThrow("公网 URL");
    expect(calls).toHaveLength(1);
    await createVideoGenerationsTask(deps, {...config, baseUrl: "https://other.example"}, model, "test", [{...image, url: "https://media.example/image.png"}], [], []);
    expect(calls[1]).toMatchObject({body: {image_urls: ["https://media.example/image.png"]}});
});

test("custom channel profiles take their capability from the configured protocol", () => {
    const channel = createModelChannel({id: "studio", baseUrl: "https://api.example.com", apiKey: "synthetic-key", models: ["clip-x"], modelProfiles: [{model: "clip-x", capability: "text", protocol: "newapi-channel-2"}]});
    const config = normalizeConfigSnapshot({config: {...defaultConfig, channels: [channel]}}).config;
    const profile = config.channels[0]!.modelProfiles!.find((item) => item.model === "clip-x")!;
    expect(profile).toMatchObject({capability: "video", protocol: "newapi-channel-2"});
});
