import { afterEach, describe, expect, test } from "bun:test";
import { App } from "antd";
import axios from "axios";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CanvasVideoSettingsPopover } from "../src/components/canvas/canvas-video-settings-popover";
import { VideoSettingsPanel } from "../src/components/video-settings-panel";
import { canvasThemes } from "../src/lib/canvas-theme";
import { mergeFetchedChannelModelProfiles, type ChannelModelCatalogItem } from "../src/lib/channel-model-catalog";
import { defaultModelCapabilityConfig, pluginWorkflowCapabilityConfig } from "../src/lib/model-capabilities";
import { ChannelModelSettings } from "../src/pages/settings/channel-model-settings";
import { applyFetchedChannelModelCatalog } from "../src/pages/settings/channel-settings-pane";
import { fetchChannelModels } from "../src/services/api/image";
import { disconnectBeefAPIConnection } from "../src/services/api/beefapi-connection";
import { getActiveUserScope, setActiveUserScope } from "../src/lib/user-scope";
import { apiClient } from "../src/services/api/request";
import { createVideoGenerationTask } from "../src/services/api/video";
import { createModelChannel, defaultConfig, modelDisplayName, normalizeConfigSnapshot, resolveModelRequestConfig, selectableModelsByCapability, type AiConfig } from "../src/stores/use-config-store";

const originalAxiosRequest = axios.request;
const originalApiRequest = apiClient.request;

test("官方GPT图片旧默认配置升级质量和21:9尺寸，保留显式限制与第三方配置", () => {
    const model = "gpt-image-2.5-flare";
    const legacy = defaultModelCapabilityConfig("openai-image", "gpt-image-2");
    legacy.image!.quality = { supported: true, values: ["auto", "low", "medium", "high"], default: "auto" };
    legacy.image!.size.values = ["2048x878"];
    legacy.image!.size.default = "2048x878";
    legacy.image!.size.presets = [{ tier: "1k", ratio: "21:9", size: "2048x878", width: 2048, height: 878 }];
    const configFor = (baseUrl: string, capabilityConfig = legacy) => normalizeConfigSnapshot({ config: { ...defaultConfig, channels: [createModelChannel({ id: "beefapi", baseUrl, models: [model], modelProfiles: [{ model, capability: "image", protocol: "openai-image", capabilityConfig }] })] } }).config;
    const upgraded = configFor("https://enterprise.beefapi.com/v1").channels[0]!.modelProfiles![0]!.capabilityConfig!.image!;
    expect(upgraded.quality.values).toEqual(["auto", "low", "medium", "high", "xhigh", "max"]);
    expect(upgraded.size.default).toBe("2048x880");
    expect(upgraded.size.presets![0]!.height).toBe(880);
    expect(legacy.image!.size.values).toEqual(["2048x878"]);
    const restricted = structuredClone(legacy);
    restricted.image!.quality = { supported: true, values: ["low"], default: "low" };
    expect(configFor("https://enterprise.beefapi.com/v1", restricted).channels[0]!.modelProfiles![0]!.capabilityConfig!.image!.quality.values).toEqual(["low"]);
    expect(configFor("https://custom.example.com/v1").channels[0]!.modelProfiles![0]!.capabilityConfig!.image!.quality.values).toEqual(["auto", "low", "medium", "high"]);
});

afterEach(() => {
    axios.request = originalAxiosRequest;
    apiClient.request = originalApiRequest;
});

test("backend discovery forwards cancellation and preserves AbortError", async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    apiClient.request = (async (config: { signal?: AbortSignal }) => {
        received = config.signal;
        throw new DOMException("cancelled", "AbortError");
    }) as typeof apiClient.request;
    await expect(fetchChannelModels(createModelChannel({ id: "custom", baseUrl: "https://example.test/v1", apiKey: "dummy" }), true, controller.signal)).rejects.toBeInstanceOf(DOMException);
    expect(received).toBe(controller.signal);
});

const omniCatalog: ChannelModelCatalogItem = {
    id: "omni",
    displayName: "Omni Flash",
    modelType: "video",
    supportsImages: false,
    minImages: 0,
    maxImages: 0,
    defaultParameters: { aspectRatio: "16:9", durationSeconds: "10" },
    options: {
        aspectRatio: [{ value: "16:9" }, { value: "9:16" }],
        durationSeconds: [{ value: "8" }, { value: "10" }],
    },
};

function configForCatalog(catalog: ChannelModelCatalogItem[], input: Partial<AiConfig> = {}) {
    const channel = createModelChannel({
        id: "flow",
        name: "Flow2API",
        baseUrl: "https://flow.example",
        apiKey: "synthetic-test-key",
        apiFormat: "openai",
        models: catalog.map((item) => item.id),
    });
    const configured = { ...channel, modelProfiles: mergeFetchedChannelModelProfiles(channel, catalog) };
    const normalized = normalizeConfigSnapshot({
        config: {
            ...defaultConfig,
            ...input,
            channels: [configured],
            model: `flow::${catalog[0]!.id}`,
            videoModel: `flow::${catalog[0]!.id}`,
        },
    }).config;
    return input.vquality ? { ...normalized, vquality: input.vquality } : normalized;
}

function formEntries(body: unknown) {
    expect(body).toBeInstanceOf(FormData);
    return Object.fromEntries(Array.from((body as FormData).entries()).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

describe("public channel model catalog", () => {
    test("managed catalog drops delayed results after user or enterprise connection changes", async () => {
        const originalScope = getActiveUserScope();
        try {
            for (const change of [() => { setActiveUserScope("catalog-other-user"); }, () => disconnectBeefAPIConnection()]) {
                let release!: () => void;
                apiClient.request = (async (request) => {
                    if (request.url === "/beefapi/connection/models") await new Promise<void>((resolve) => { release = resolve; });
                    return { status: 200, data: { code: 0, data: { models: [{ id: "seedance-2.0-portrait" }] }, msg: "" } };
                }) as typeof apiClient.request;
                const pending = fetchChannelModels(createModelChannel({ id: "beefapi", credentialRef: "beefapi-enterprise" }), true);
                const outcome = pending.catch((error) => error);
                await change();
                release();
                expect(await outcome).toMatchObject({ name: "UserScopeAbandonedError" });
            }
        } finally {
            setActiveUserScope(originalScope);
        }
    });
    test("managed catalog refresh persists through the trusted endpoint without accepting client credentials or prices", async () => {
        const requests: Array<{ url?: string; data?: unknown }> = [];
        apiClient.request = (async (request) => {
            requests.push(request);
            return { status: 200, data: { code: 0, data: { models: [{ id: "seedance-2.0-portrait" }] }, msg: "" } };
        }) as typeof apiClient.request;
        await fetchChannelModels(createModelChannel({ id: "beefapi", credentialRef: "beefapi-enterprise", apiKey: "synthetic-ignored", baseUrl: "https://ignored.example" }), true);
        expect(requests[0]?.url).toBe("/beefapi/connection/models");
        expect(requests[0]?.data).toEqual({});
        await fetchChannelModels(createModelChannel({ id: "manual", apiKey: "synthetic-local", baseUrl: "https://manual.example" }), true);
        expect(requests[1]?.url).toBe("/ai/models");
        expect(requests[1]?.data).toMatchObject({ baseUrl: "https://manual.example", apiKey: "synthetic-local" });
    });
    test("backend catalogue authentication failure keeps its actionable message", async () => {
        apiClient.request = (async () => ({ status: 502, data: { code: 502, data: null, msg: "模型服务鉴权失败，请检查 API Key", reason: "bad_gateway" } })) as typeof apiClient.request;
        await expect(fetchChannelModels(createModelChannel({ apiKey: "synthetic-invalid" }), true)).rejects.toThrow("模型服务鉴权失败，请检查 API Key");
    });
    test("direct discovery forwards custom headers for OpenAI and Gemini", async () => {
        const requests: Array<Record<string, unknown>> = [];
        axios.request = (async (request: Record<string, unknown>) => {
            requests.push(request);
            return { status: 200, data: { data: [{ id: "custom-model" }], models: [{ name: "models/gemini-pro" }] } };
        }) as typeof axios.request;
        for (const apiFormat of ["openai", "gemini"] as const) {
            await fetchChannelModels(createModelChannel({ baseUrl: "https://provider.example", apiFormat, apiKey: "synthetic-key", headers: [{ name: "X-Project-Key", value: "synthetic-header" }] }));
        }
        expect(requests).toHaveLength(2);
        for (const request of requests) {
            const headers = request.headers as Record<string, string>;
            expect(JSON.parse(atob(headers["x-canvas-upstream-headers"]))).toEqual([{ name: "X-Project-Key", value: "synthetic-header" }]);
        }
    });
    test("keeps the fetched BeefAPI catalog dynamic while normalizing discovered image profiles", () => {
        const channel = createModelChannel({
            id: "beefapi",
            name: "BeefAPI",
            baseUrl: "https://enterprise.beefapi.com",
            apiKey: "synthetic-test-key",
            models: ["gpt-5.6-sol", "gpt-image-2", "hy-image-v3", "brand-new-upstream-model"],
        });
        const normalized = normalizeConfigSnapshot({ config: { ...defaultConfig, channels: [channel], imageModel: "beefapi::gpt-image-2" } }).config;
        const beef = normalized.channels[0]!;

        expect(beef.models).toEqual(["gpt-5.6-sol", "gpt-image-2", "hy-image-v3", "brand-new-upstream-model"]);
        expect(beef.modelProfiles?.filter((item) => item.capability === "video")).toEqual([]);
        expect(beef.modelProfiles).toEqual(expect.arrayContaining([
            expect.objectContaining({ model: "gpt-5.6-sol", capability: "text", protocol: "chat-completion" }),
            expect.objectContaining({ model: "gpt-image-2", capability: "image", protocol: "openai-image" }),
            expect.objectContaining({ model: "brand-new-upstream-model", capability: "text", protocol: "chat-completion" }),
            expect.objectContaining({ model: "hy-image-v3", capability: "image", protocol: "openai-image" }),
        ]));
        expect(resolveModelRequestConfig(normalized, "beefapi::gpt-image-2").interfaceType).toBe("openai-image");
        expect(resolveModelRequestConfig(normalized, "beefapi::gpt-5.6-sol").interfaceType).toBe("chat-completion");
    });

    test("repairs stale chat protocols on known BeefAPI image models without changing custom routes", () => {
        const make = (baseUrl: string) => createModelChannel({ id: "test", baseUrl, apiKey: "synthetic-key", models: ["gpt-image-2"], modelProfiles: [{ model: "gpt-image-2", capability: "text", protocol: "chat-completion" }] });
        const official = normalizeConfigSnapshot({ config: { ...defaultConfig, channels: [make("https://enterprise.beefapi.com")] } }).config;
        expect(selectableModelsByCapability(official, "image")).toEqual(["test::gpt-image-2"]);
        expect(resolveModelRequestConfig(official, "test::gpt-image-2").interfaceType).toBe("openai-image");
        const custom = normalizeConfigSnapshot({ config: { ...defaultConfig, channels: [make("https://studio.example")] } }).config;
        expect(resolveModelRequestConfig(custom, "test::gpt-image-2").interfaceType).toBe("chat-completion");
    });

    test("maps BeefAPI speech and music to audio without treating ASR as chat or TTS", () => {
        const catalog: ChannelModelCatalogItem[] = [
            { id: "gpt-5.6-sol", modelType: "text", supportedEndpointTypes: ["openai"] },
            { id: "gpt-image-2", modelType: "image", supportedEndpointTypes: ["image-generation"] },
            { id: "seedance-2.0", modelType: "video", supportedEndpointTypes: ["openai-video"] },
            { id: "minimax-speech-2.8-hd", supportedEndpointTypes: ["openai"] },
            { id: "minimax-speech-2.8-turbo", supportedEndpointTypes: ["openai"] },
            { id: "minimax-music-v3.0", supportedEndpointTypes: ["openai"] },
            { id: "hy-asr-3.0-preview", supportedEndpointTypes: ["openai"] },
        ];
        const channel = createModelChannel({
            id: "beefapi",
            name: "BeefAPI",
            pinned: true,
            baseUrl: "https://enterprise.beefapi.com",
            models: catalog.map((item) => item.id),
            modelProfiles: [
                { model: "minimax-speech-2.8-hd", capability: "text", protocol: "chat-completion" },
                { model: "hy-asr-3.0-preview", capability: "text", protocol: "chat-completion" },
            ],
        });
        const merged = { ...channel, modelProfiles: mergeFetchedChannelModelProfiles(channel, catalog) };
        const normalized = normalizeConfigSnapshot({
            config: { ...defaultConfig, channels: [merged], imageModel: "beefapi::gpt-image-2", videoModel: "beefapi::seedance-2.0", textModel: "beefapi::gpt-5.6-sol" },
        }).config;

        expect(selectableModelsByCapability(normalized, "audio").map((model) => model.split("::").pop())).toEqual([
            "minimax-speech-2.8-hd",
            "minimax-speech-2.8-turbo",
            "minimax-music-v3.0",
        ]);
        expect(selectableModelsByCapability(normalized, "text").map((model) => model.split("::").pop())).toEqual(["gpt-5.6-sol"]);
        expect(selectableModelsByCapability(normalized, "image").map((model) => model.split("::").pop())).toEqual(["gpt-image-2"]);
        expect(selectableModelsByCapability(normalized, "video").some((model) => model.includes("seedance-2.0"))).toBe(true);
        expect(normalized.audioModel).toContain("minimax-speech-2.8-hd");
        expect(resolveModelRequestConfig(normalized, "beefapi::minimax-speech-2.8-hd").interfaceType).toBe("openai-audio");
        expect(resolveModelRequestConfig(normalized, "beefapi::minimax-music-v3.0").interfaceType).toBe("openai-audio");
        expect(merged.modelProfiles?.find((item) => item.model === "hy-asr-3.0-preview")?.protocol).toBeUndefined();
        expect(merged.modelProfiles?.find((item) => item.model === "hy-asr-3.0-preview")?.capability).toBeUndefined();
    });

    test("preserves explicit custom-channel profiles on speech-named and ASR-named models", () => {
        const channel = createModelChannel({
            id: "studio",
            name: "工作室渠道",
            baseUrl: "https://api.example.com",
            models: ["speech-helper", "hy-asr-3.0-preview", "classr-notes"],
            modelProfiles: [
                { model: "speech-helper", capability: "image", protocol: "openai-image" },
                { model: "hy-asr-3.0-preview", capability: "text", protocol: "chat-completion" },
                { model: "classr-notes", capability: "text", protocol: "openai-response" },
            ],
        });
        const profiles = mergeFetchedChannelModelProfiles(channel, [
            { id: "speech-helper", supportedEndpointTypes: ["openai"] },
            { id: "hy-asr-3.0-preview", supportedEndpointTypes: ["openai"] },
            { id: "classr-notes", supportedEndpointTypes: ["openai"] },
        ]);
        expect(profiles).toEqual(expect.arrayContaining([
            expect.objectContaining({ model: "speech-helper", capability: "image", protocol: "openai-image" }),
            expect.objectContaining({ model: "hy-asr-3.0-preview", capability: "text", protocol: "chat-completion" }),
            expect.objectContaining({ model: "classr-notes", capability: "text", protocol: "openai-response" }),
        ]));
    });

    test("preserves an explicitly configured BeefAPI text protocol", () => {
        const channel = createModelChannel({
            id: "beefapi",
            name: "BeefAPI",
            baseUrl: "https://enterprise.beefapi.com",
            models: ["custom-text-model"],
            modelProfiles: [{ model: "custom-text-model", capability: "text", protocol: "openai-response" }],
        });
        const normalized = normalizeConfigSnapshot({ config: { ...defaultConfig, channels: [channel], textModel: "beefapi::custom-text-model" } }).config;

        expect(normalized.channels[0]?.modelProfiles).toEqual(expect.arrayContaining([
            expect.objectContaining({ model: "custom-text-model", capability: "text", protocol: "openai-response" }),
        ]));
        expect(resolveModelRequestConfig(normalized, "beefapi::custom-text-model").interfaceType).toBe("openai-response");
    });

    test("projects Manifest video workflow parameters without inventing a size capability", () => {
        const profile = pluginWorkflowCapabilityConfig("autodl-comfyui", {
            id: "minimax_h3_lightx2v_no_pic",
            label: "MiniMax H3 文生视频",
            providerId: "autodl-comfyui",
            capability: "video",
            parameters: [
                { name: "prompt", type: "string", required: true, mapping: "prompt" },
                { name: "duration", type: "integer", mapping: "duration" },
                { name: "resolution", type: "string", mapping: "resolution", values: ["480p竖", "480p横"] },
            ],
            defaults: { duration: 5, resolution: "480p竖" },
        })!.video!;

        expect(profile.ratios).toEqual([]);
        expect(profile.defaultRatio).toBe("");
        expect(profile.resolutions).toEqual(["480p竖", "480p横"]);
        expect(profile.defaultResolution).toBe("480p竖");
        expect(profile.duration).toEqual({ selection: "enum", values: [5], default: 5 });
    });

    test("preserves six public capabilities without expanding compatibility IDs", async () => {
        apiClient.request = (async () => ({
            data: {
                code: 0,
                data: {
                    models: [
                        { id: "image-fast", displayName: "Image Fast", modelType: "image" },
                        { id: "image-quality", displayName: "Image Quality", modelType: "image" },
                        { ...omniCatalog, compatibilityMap: [{ modelId: "omni_portrait_10s" }] },
                        { id: "veo-lite", displayName: "Veo Lite", modelType: "video" },
                        { id: "veo-fast", displayName: "Veo Fast", modelType: "video" },
                        { id: "veo-quality", displayName: "Veo Quality", modelType: "video" },
                    ],
                },
            },
        })) as typeof apiClient.request;
        const channel = createModelChannel({ baseUrl: "https://flow.example", apiKey: "synthetic-test-key", models: [] });

        const result = await fetchChannelModels(channel, true);

        expect(result.models).toHaveLength(6);
        expect(result.models).toContain("omni");
        expect(result.models).not.toContain("omni_portrait_10s");
        expect(result.catalog.find((item) => item.id === "omni")).toEqual(omniCatalog);
        expect(result.catalog.find((item) => item.id === "omni")).not.toHaveProperty("compatibilityMap");
    });

    test("preserves OpenAI-compatible capability metadata during direct model discovery", async () => {
        axios.request = (async () => ({
            data: {
                data: [
                    { id: "image-v1", display_name: "Image V1", model_type: "image", supported_endpoint_types: ["openai-image"] },
                    { id: "video-v1", display_name: "Video V1", model_type: "video", supported_endpoint_types: ["openai-video"] },
                ],
            },
        })) as typeof axios.request;
        const channel = createModelChannel({ baseUrl: "https://provider.example", apiKey: "synthetic-test-key", models: [] });

        const result = await fetchChannelModels(channel);

        expect(result.models).toEqual(["image-v1", "video-v1"]);
        expect(result.catalog).toEqual([
            expect.objectContaining({ id: "image-v1", modelType: "image", supportedEndpointTypes: ["openai-image"] }),
            expect.objectContaining({ id: "video-v1", modelType: "video", supportedEndpointTypes: ["openai-video"] }),
        ]);
    });

    test("refresh application preserves discovered capabilities in the saved channel", () => {
        const channel = createModelChannel({ id: "beefapi", name: "BeefAPI", baseUrl: "https://enterprise.beefapi.com", models: ["old-model"] });
        const next = applyFetchedChannelModelCatalog(channel, {
            models: ["seedance-2.5"],
            catalog: [{ id: "seedance-2.5", displayName: "Seedance 2.5", modelType: "video", supportedEndpointTypes: ["openai"] }],
        });

        expect(next.models).toEqual(["seedance-2.5"]);
        expect(next.modelProfiles).toEqual([expect.objectContaining({ model: "seedance-2.5", capability: "video" })]);
    });

    test("maps Omni metadata to friendly video/NewAPI configuration with 8/10 seconds and both ratios", () => {
        const config = configForCatalog([omniCatalog]);
        const model = "flow::omni";
        const profile = config.channels[0]!.modelProfiles![0]!;

        expect(modelDisplayName(config, model)).toBe("Omni Flash");
        expect(selectableModelsByCapability(config, "video")).toEqual([model]);
        expect(selectableModelsByCapability(config, "text")).toEqual([]);
        expect(resolveModelRequestConfig(config, model).interfaceType).toBe("newapi");
        expect(profile.capabilityConfig?.video).toMatchObject({
            duration: { selection: "enum", values: [8, 10], default: 10 },
            ratios: ["16:9", "9:16"],
            defaultRatio: "16:9",
            resolutions: [],
            defaultResolution: "",
        });
    });

    test("does not infer a protocol from endpoint-only video metadata", () => {
        const catalog: ChannelModelCatalogItem = {
            id: "endpoint-video",
            supportedEndpointTypes: ["openai-video"],
        };
        const config = configForCatalog([catalog], { videoSeconds: "6", size: "16:9", vquality: "720" });

        expect(config.channels[0]!.modelProfiles).toEqual([]);
    });

    test("preserves a manually configured capability profile when a catalog only returns an ID", () => {
        const channel = createModelChannel({
            id: "manual",
            name: "Manual",
            baseUrl: "https://manual.example",
            apiKey: "synthetic-test-key",
            apiFormat: "openai",
            models: ["manual-video"],
        });
        const capabilityConfig = defaultModelCapabilityConfig("newapi", "manual-video");
        capabilityConfig.video!.resolutions = ["1440p"];
        capabilityConfig.video!.defaultResolution = "1440p";
        channel.modelProfiles = [{ model: "manual-video", displayName: "Manual Video", capability: "video", protocol: "newapi", billingMode: "fixed_request", unitPriceMicrocredits: 0, capabilityConfig }];

        const profiles = mergeFetchedChannelModelProfiles(channel, [{ id: "manual-video" }]);

        expect(profiles[0]?.capabilityConfig).toEqual(capabilityConfig);
        expect(profiles[0]?.displayName).toBe("Manual Video");
    });

    test("preserves an ID-only manual model profile when the per-model protocol is missing", () => {
        const channel = createModelChannel({
            id: "manual-text-channel",
            name: "Manual Text Channel",
            baseUrl: "https://manual.example",
            apiKey: "synthetic-test-key",
            apiFormat: "openai",
            interfaceType: "chat-completion",
            models: ["manual-video"],
        });
        const capabilityConfig = defaultModelCapabilityConfig("newapi", "manual-video");
        capabilityConfig.video!.resolutions = ["1440p"];
        capabilityConfig.video!.defaultResolution = "1440p";
        const existing = {
            model: "manual-video",
            displayName: "Manual Video",
            capability: "video" as const,
            billingMode: "per_second" as const,
            unitPriceMicrocredits: 4321,
            inputTokenPriceMicrocredits: 11,
            outputTokenPriceMicrocredits: 22,
            cachedTokenPriceMicrocredits: 3,
            capabilityConfig,
        };
        channel.modelProfiles = [existing];

        const profiles = mergeFetchedChannelModelProfiles(channel, [{ id: "manual-video", displayName: "Catalog Video" }]);

        expect(profiles[0]).toEqual({ ...existing, displayName: "Catalog Video" });
    });

    test("uses modelType only for capability and preserves an existing manual protocol and profile", () => {
        const channel = createModelChannel({
            id: "manual-partial",
            name: "Manual Partial",
            baseUrl: "https://manual.example",
            apiKey: "synthetic-test-key",
            apiFormat: "openai",
            interfaceType: "chat-completion",
            models: ["video-x"],
        });
        const capabilityConfig = defaultModelCapabilityConfig("gemini-veo", "video-x");
        capabilityConfig.video!.resolutions = ["1440p"];
        capabilityConfig.video!.defaultResolution = "1440p";
        channel.modelProfiles = [{ model: "video-x", capability: "video", protocol: "gemini-veo", billingMode: "per_second", unitPriceMicrocredits: 7654, capabilityConfig }];

        const profiles = mergeFetchedChannelModelProfiles(channel, [{ id: "video-x", modelType: "video" }]);

        expect(profiles).toEqual(channel.modelProfiles);
    });

    test("requires the declared minimum image count and selects image-to-video", async () => {
        const catalog: ChannelModelCatalogItem = {
            id: "image-required-video",
            modelType: "video",
            minImages: 1,
            maxImages: 2,
        };
        const config = configForCatalog([catalog]);
        const profile = config.channels[0]!.modelProfiles![0]!.capabilityConfig!.video!;

        expect(profile.references).toMatchObject({ minImages: 1, maxImages: 2 });
        expect(profile.operations).toEqual(["image_to_video"]);
        expect(profile.defaultOperation).toBe("image_to_video");
        expect(createVideoGenerationTask(config, "synthetic prompt")).rejects.toThrow("至少需要 1 张参考图");
    });

    test("preserves an ID-only manual video model profile when both protocol sources are missing", () => {
        const channel = createModelChannel({
            id: "manual-no-protocol",
            name: "Manual No Protocol",
            baseUrl: "https://manual.example",
            apiKey: "synthetic-test-key",
            apiFormat: "openai",
            models: ["manual-video"],
        });
        const capabilityConfig = defaultModelCapabilityConfig("newapi", "manual-video");
        capabilityConfig.video!.resolutions = ["1440p"];
        capabilityConfig.video!.defaultResolution = "1440p";
        const existing = {
            model: "manual-video",
            displayName: "Manual Video",
            capability: "video" as const,
            billingMode: "per_second" as const,
            unitPriceMicrocredits: 8765,
            inputTokenPriceMicrocredits: 31,
            outputTokenPriceMicrocredits: 47,
            cachedTokenPriceMicrocredits: 5,
            capabilityConfig,
        };
        channel.modelProfiles = [existing];

        const profiles = mergeFetchedChannelModelProfiles(channel, [{ id: "manual-video", displayName: "Catalog Video" }]);

        expect(profiles).toEqual([{ ...existing, displayName: "Catalog Video" }]);
    });

    test("does not show a synthetic 720P label in the Canvas summary when the model declares no resolutions", () => {
        const config = configForCatalog([omniCatalog], { videoSeconds: "10", size: "16:9", vquality: "720" });

        const html = renderToStaticMarkup(React.createElement(CanvasVideoSettingsPopover, { config, onConfigChange: () => undefined }));

        expect(html).toContain("16:9 · 10s");
        expect(html).not.toContain("720P");
    });

    test("does not show size controls when the video capability declares no ratios", () => {
        const config = configForCatalog([omniCatalog], { videoSeconds: "10", size: "16:9", vquality: "1080" });
        const profile = config.channels[0]!.modelProfiles![0]!.capabilityConfig!.video!;
        profile.ratios = [];
        profile.defaultRatio = "";
        profile.resolutions = ["1080p"];
        profile.defaultResolution = "1080p";

        const summaryHtml = renderToStaticMarkup(React.createElement(CanvasVideoSettingsPopover, { config, onConfigChange: () => undefined }));
        const panelHtml = renderToStaticMarkup(React.createElement(VideoSettingsPanel, { config, onConfigChange: () => undefined, theme: canvasThemes.dark }));

        expect(summaryHtml).toContain("1080P · 10s");
        expect(summaryHtml).not.toContain("16:9");
        expect(panelHtml).not.toContain("尺寸");
    });

    test("shows dimensions derived from the selected video resolution and ratio", () => {
        const config = configForCatalog([omniCatalog], { videoSeconds: "10", size: "16:9", vquality: "1080" });
        const profile = config.channels[0]!.modelProfiles![0]!.capabilityConfig!.video!;
        profile.resolutions = ["720p", "1080p", "2160p"];
        profile.defaultResolution = "720p";

        const panelHtml = renderToStaticMarkup(React.createElement(VideoSettingsPanel, { config, onConfigChange: () => undefined, theme: canvasThemes.dark }));

        expect(panelHtml).toContain("1920");
        expect(panelHtml).toContain("1080");
        expect(panelHtml).not.toContain("1280");
    });

    test("shows the public display name in channel model settings instead of only the internal ID", () => {
        const config = configForCatalog([omniCatalog]);

        const html = renderToStaticMarkup(React.createElement(App, null, React.createElement(ChannelModelSettings, { channel: config.channels[0]!, onChange: () => undefined })));

        expect(html).toContain("Omni Flash");
    });

    test("builds the creation catalog only from public backend models and user channels", () => {
        const platform = createModelChannel({
            id: "public-logical-models",
            name: "平台模型",
            scope: "system",
            apiKey: "system",
            models: ["frontend-image"],
            modelProfiles: [{ model: "frontend-image", capability: "image", billingMode: "fixed_request", unitPriceMicrocredits: 0 }],
        });
        const custom = createModelChannel({
            id: "custom-channel",
            name: "我的渠道",
            baseUrl: "https://custom.example.com",
            apiKey: "synthetic-test-key",
            models: ["custom-image-v1"],
        });
        const normalized = normalizeConfigSnapshot({
            config: {
                ...defaultConfig,
                channels: [platform, custom, createModelChannel({ id: "default", name: "默认渠道", apiKey: "", models: ["gpt-image-2"] })],
                models: ["default::gpt-image-2", "ghost-image"],
                imageModels: ["default::gpt-image-2", "ghost-image"],
                imageModel: "default::gpt-image-2",
            },
        }).config;
        const staleSnapshot = { ...normalized, models: [...normalized.models, "ghost-image"], imageModels: [...normalized.imageModels, "ghost-image"] };

        expect(selectableModelsByCapability(staleSnapshot, "image")).toEqual(["public-logical-models::frontend-image", "custom-channel::custom-image-v1"]);
        expect(staleSnapshot.channels.some((channel) => channel.id === "default")).toBe(false);
        expect(selectableModelsByCapability(staleSnapshot, "image")).not.toContain("default::gpt-image-2");
        expect(selectableModelsByCapability(staleSnapshot, "image")).not.toContain("ghost-image");
    });

    test("omits resolution_name for Omni and for auto instead of inventing 720p", async () => {
        const bodies: Record<string, string>[] = [];
        axios.request = (async (request) => {
            bodies.push(formEntries(request.data));
            return { data: { id: `synthetic-${bodies.length}` } };
        }) as typeof axios.request;

        const omniConfig = configForCatalog([omniCatalog], { videoSeconds: "10", size: "16:9", vquality: "720" });
        await createVideoGenerationTask(omniConfig, "synthetic prompt");

        const declaredResolution: ChannelModelCatalogItem = {
            ...omniCatalog,
            id: "veo-public",
            displayName: "Veo Public",
            defaultParameters: { ...omniCatalog.defaultParameters, durationSeconds: "8", resolution: "1080p" },
            options: { ...omniCatalog.options, durationSeconds: [{ value: "8" }], resolution: [{ value: "720p" }, { value: "1080p" }] },
        };
        const autoConfig = configForCatalog([declaredResolution], { videoSeconds: "8", size: "16:9", vquality: "auto" });
        await createVideoGenerationTask(autoConfig, "synthetic prompt");

        expect(bodies[0]).not.toHaveProperty("resolution_name");
        expect(bodies[1]).not.toHaveProperty("resolution_name");
    });

    test("sends a declared compatible HD resolution for a video capability", async () => {
        let body: Record<string, string> = {};
        axios.request = (async (request) => {
            body = formEntries(request.data);
            return { data: { id: "synthetic-hd" } };
        }) as typeof axios.request;
        const catalog: ChannelModelCatalogItem = {
            ...omniCatalog,
            id: "veo-public",
            displayName: "Veo Public",
            defaultParameters: { aspectRatio: "16:9", durationSeconds: "8", resolution: "1080p" },
            options: { ...omniCatalog.options, durationSeconds: [{ value: "8" }], resolution: [{ value: "1080p" }] },
        };
        const config = configForCatalog([catalog], { videoSeconds: "8", size: "16:9", vquality: "1080" });

        await createVideoGenerationTask(config, "synthetic prompt");

        expect(body.resolution_name).toBe("1080p");
        expect(body.model).toBe("veo-public");
        expect(body.seconds).toBe("8");
        expect(body.size).toBe("1280x720");
    });

    test("preserves provider resolution enums with direction suffixes across Canvas display and requests", async () => {
        let body: Record<string, string> = {};
        axios.request = (async (request) => {
            body = formEntries(request.data);
            return { data: { id: "synthetic-directional" } };
        }) as typeof axios.request;
        const catalog: ChannelModelCatalogItem = {
            ...omniCatalog,
            id: "directional-video",
            displayName: "Directional Video",
            defaultParameters: { aspectRatio: "16:9", durationSeconds: "8", resolution: "768p竖" },
            options: {
                ...omniCatalog.options,
                durationSeconds: [{ value: "8" }],
                resolution: [{ value: "480p竖" }, { value: "768p竖" }, { value: "480p横" }, { value: "768p横" }],
            },
        };
        const config = configForCatalog([catalog], { videoSeconds: "8", size: "16:9", vquality: "768P竖" });

        const html = renderToStaticMarkup(React.createElement(CanvasVideoSettingsPopover, { config, onConfigChange: () => undefined }));
        const panelHtml = renderToStaticMarkup(React.createElement(VideoSettingsPanel, { config, onConfigChange: () => undefined, theme: canvasThemes.dark }));
        await createVideoGenerationTask(config, "synthetic prompt");

        expect(html).toContain("768P竖 · 16:9 · 8s");
        expect(panelHtml).toMatch(/aria-pressed="true"[^>]*>768P竖<\/button>/);
        expect(body.resolution_name).toBe("768p竖");
    });
});
