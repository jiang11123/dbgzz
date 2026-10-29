import { expect, test } from "bun:test";
import { defaultImageCapabilityConfig } from "../src/lib/model-capabilities";
import { mergeFetchedChannelModelProfiles } from "../src/lib/channel-model-catalog";
import { createModelChannel, defaultConfig, normalizeConfigSnapshot, resolveModelRequestConfig } from "../src/stores/use-config-store";

test("known BeefAPI Hy image repairs stale text profiles and capability limits on reload", () => {
    const channel = createModelChannel({ id: "beefapi", baseUrl: "https://beeftv.app", models: ["hy-image-v3"], modelProfiles: [{ model: "hy-image-v3", capability: "image", protocol: "chat-completion" }] });
    const config = normalizeConfigSnapshot({ config: { ...defaultConfig, channels: [channel], imageModel: "beefapi::hy-image-v3" } }).config;
    const resolved = resolveModelRequestConfig(config, "beefapi::hy-image-v3");
    expect(resolved.interfaceType).toBe("openai-image");
    expect(config.channels[0]!.modelProfiles![0]!.capabilityConfig?.image).toMatchObject({ references: { maxImages: 3, maxImageBytes: 10485760, maskSupported: false }, quality: { supported: false }, maxOutputs: 1 });
    const custom = normalizeConfigSnapshot({ config: { ...defaultConfig, channels: [{ ...channel, id: "studio", baseUrl: "https://studio.example" }] } }).config;
    expect(resolveModelRequestConfig(custom, "studio::hy-image-v3").interfaceType).toBe("chat-completion");
});

test("managed refresh maps precise image, video and text endpoints while leaving generic custom contracts intact", () => {
    const catalog = [
        { id: "hy-image-v3", supportedEndpointTypes: ["openai"] },
        { id: "opaque-image", supportedEndpointTypes: ["images.generations"] },
        { id: "opaque-video", supportedEndpointTypes: ["openai-video"] },
        { id: "opaque-text", supportedEndpointTypes: ["responses"] },
    ];
    const channel = createModelChannel({ id: "beefapi", baseUrl: "https://beeftv.app" });
    expect(mergeFetchedChannelModelProfiles(channel, catalog)).toEqual(expect.arrayContaining([
        expect.objectContaining({ model: "hy-image-v3", capability: "image", protocol: "openai-image" }),
        expect.objectContaining({ model: "opaque-image", capability: "image", protocol: "openai-image" }),
        expect.objectContaining({ model: "opaque-video", capability: "video", protocol: "openai-videos" }),
        expect.objectContaining({ model: "opaque-text", capability: "text", protocol: "openai-response" }),
    ]));
    expect(defaultImageCapabilityConfig("openai-image", "hy-image-v3").size.values).not.toContain("2048x2048");
});
