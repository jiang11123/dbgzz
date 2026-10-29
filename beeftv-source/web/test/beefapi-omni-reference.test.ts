import { expect, test } from "bun:test";
import { defaultModelCapabilityConfig, modelCapabilityConfigFor } from "../src/lib/model-capabilities";
import { modelCompatibilityError } from "../src/lib/model-selection";
import { createModelChannel, defaultConfig, normalizeConfigSnapshot, resolveModelRequestConfig } from "../src/stores/use-config-store";

for (const model of ["seedance-2.0", "seedance-2.0-fast", "seedance-2.0-mini", "seedance-2.5", "seedance-2.5-official"]) {
    test(`${model} enterprise catalog needs no manual protocol selection`, () => {
        const channel = createModelChannel({ id: "beefapi", baseUrl: "https://enterprise.beefapi.com", models: [model] });
        const config = normalizeConfigSnapshot({ config: { ...defaultConfig, channels: [channel] } }).config;
        expect(resolveModelRequestConfig(config, `beefapi::${model}`).interfaceType).toBe("newapi");
    });
    for (const legacy of [false, true]) {
        test(`${model} supports mixed references after ${legacy ? "legacy restore" : "catalog import"} and reload`, async () => {
            const manifest = await Bun.file(new URL("../../plugin-packages/openai-videos/manifest.json", import.meta.url)).json();
            const capabilityConfig = defaultModelCapabilityConfig("newapi-channel-2", model);
            capabilityConfig.video!.operations = ["text_to_video", "image_to_video"];
            Object.assign(capabilityConfig.video!.references, { maxImages: 9, maxVideos: 0, maxAudios: 0, maxVideoDurationSeconds: 0, maxAudioDurationSeconds: 0 });
            const channel = createModelChannel({ id: "beefapi", baseUrl: "https://enterprise.beefapi.com", models: [model], modelProfiles: [{ model, capability: "video", protocol: "openai-videos", ...(legacy ? { capabilityConfig } : {}) }] });
            let config = { ...defaultConfig, channels: [channel] };
            for (let reload = 0; reload < 2; reload++) {
                config = normalizeConfigSnapshot({ config }).config;
                const selected = `beefapi::${model}`;
                expect(config.channels[0].modelProfiles?.find((item) => item.model === model)?.protocol).toBe("newapi");
                const request = resolveModelRequestConfig(config, selected);
                expect(manifest.contributes.providers.map((provider: { id: string }) => provider.id)).toContain(request.interfaceType);
                const profile = modelCapabilityConfigFor(config, selected).video!;
                expect(profile.references.maxVideos).toBe(model.startsWith("seedance-2.5") ? 10 : 3);
                expect(profile.references.maxAudios).toBeGreaterThan(0);
                expect(modelCompatibilityError(config, selected, { capability: "video", input: { textCount: 1, imageCount: 1, videoCount: 1, audioCount: 1, characterCount: 0 }, videoSeconds: "5", videoOperation: "reference_to_video" })).toBe("");
            }
        });
    }
}

test("OpenAI Videos Seedance catalog defaults support references without injected capabilities", () => {
    expect(defaultModelCapabilityConfig("openai-videos", "seedance-2.0-fast").video!.references.maxVideos).toBe(3);
    expect(defaultModelCapabilityConfig("openai-videos", "seedance-2.5").video!.references.maxVideos).toBe(10);
});

test("custom provider reference restrictions remain authoritative", () => {
    const model = "seedance-2.5";
    const capabilityConfig = defaultModelCapabilityConfig("newapi-channel-2", model);
    capabilityConfig.video!.references.maxVideos = 0;
    const channel = createModelChannel({ id: "custom", baseUrl: "https://example.com", models: [model], modelProfiles: [{ model, capability: "video", protocol: "newapi-channel-2", capabilityConfig }] });
    const config = normalizeConfigSnapshot({ config: { ...defaultConfig, channels: [channel] } }).config;
    expect(modelCapabilityConfigFor(config, `custom::${model}`).video!.references.maxVideos).toBe(0);
});

test("enterprise migration preserves unrelated user limits", () => {
    const model = "seedance-2.5";
    const capabilityConfig = defaultModelCapabilityConfig("newapi-channel-2", model);
    capabilityConfig.video!.operations = ["text_to_video", "image_to_video"];
    Object.assign(capabilityConfig.video!.references, { maxImages: 9, maxVideos: 0, maxAudios: 0, maxVideoDurationSeconds: 0, maxAudioDurationSeconds: 0, maxImageBytes: 1234 });
    capabilityConfig.video!.resolutions = ["720P"];
    const channel = createModelChannel({ id: "beefapi", baseUrl: "https://enterprise.beefapi.com", models: [model], modelProfiles: [{ model, capability: "video", protocol: "newapi-channel-2", capabilityConfig }] });
    const config = normalizeConfigSnapshot({ config: { ...defaultConfig, channels: [channel] } }).config;
    const video = modelCapabilityConfigFor(config, `beefapi::${model}`).video!;
    expect(video.references.maxVideos).toBe(10);
    expect(video.references.maxImageBytes).toBe(1234);
    expect(video.resolutions).toEqual(["720P"]);
});
