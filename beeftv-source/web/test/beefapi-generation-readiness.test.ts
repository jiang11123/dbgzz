import { describe, expect, test } from "bun:test";

import { listVideoReferenceModels } from "../src/lib/canvas/canvas-video-regeneration";
import { defaultModelCapabilityConfig } from "../src/lib/model-capabilities";
import { assertAudioConfig } from "../src/services/api/audio";
import { assertVideoConfig } from "../src/services/api/video-validation";
import { channelHasGenerationCredential, createModelChannel, defaultConfig, encodeChannelModel, MANAGED_BEEFAPI_CREDENTIAL_REF, resolveModelRequestConfig, useConfigStore, type AiConfig } from "../src/stores/use-config-store";

function videoCapability(model: string) {
    const capability = defaultModelCapabilityConfig("newapi-channel-2", model);
    if (capability.video) {
        capability.video.references.maxVideos = 3;
        capability.video.operations = ["text_to_video", "image_to_video", "reference_to_video"];
    }
    return capability;
}

function beefAPIConfig(connected: boolean): AiConfig {
    const image = "gpt-image-2";
    const video = "seedance-2.0";
    const channel = createModelChannel({
        id: "beefapi",
        name: "BeefAPI",
        pinned: true,
        baseUrl: "https://enterprise.beefapi.com",
        apiKey: "",
        models: [image, video],
        credentialRef: connected ? MANAGED_BEEFAPI_CREDENTIAL_REF : undefined,
        hasApiKey: connected,
        modelProfiles: [
            { model: image, capability: "image", protocol: "openai-image" },
            { model: video, capability: "video", protocol: "openai-videos", capabilityConfig: videoCapability(video) },
        ],
    });
    return {
        ...defaultConfig,
        channels: [channel],
        imageModel: encodeChannelModel("beefapi", image),
        videoModel: encodeChannelModel("beefapi", video),
        model: encodeChannelModel("beefapi", image),
    };
}

function manualConfig(apiKey: string): AiConfig {
    const channel = createModelChannel({
        id: "manual",
        name: "工作室渠道",
        baseUrl: "https://api.example.com",
        apiKey,
        models: ["local-image", "local-video"],
        modelProfiles: [
            { model: "local-image", capability: "image", protocol: "openai-image" },
            { model: "local-video", capability: "video", protocol: "newapi-channel-2", capabilityConfig: videoCapability("local-video") },
        ],
    });
    return {
        ...defaultConfig,
        channels: [channel],
        imageModel: encodeChannelModel("manual", "local-image"),
        videoModel: encodeChannelModel("manual", "local-video"),
        model: encodeChannelModel("manual", "local-image"),
    };
}

describe("managed BeefAPI generation readiness", () => {
    test("connected empty-key enterprise channel is canvas-ready for image and video", () => {
        const config = beefAPIConfig(true);
        const ready = useConfigStore.getState().isAiConfigReady;
        expect(channelHasGenerationCredential(config.channels[0])).toBe(true);
        expect(ready(config, config.imageModel)).toBe(true);
        expect(ready(config, config.videoModel)).toBe(true);
        expect(listVideoReferenceModels(config)).toEqual([config.videoModel]);
        expect(() => assertVideoConfig(resolveModelRequestConfig(config, config.videoModel), config.videoModel)).not.toThrow();
    });

    test("disconnected empty-key enterprise channel is not canvas-ready", () => {
        const config = beefAPIConfig(false);
        const ready = useConfigStore.getState().isAiConfigReady;
        expect(channelHasGenerationCredential(config.channels[0])).toBe(false);
        expect(ready(config, config.imageModel)).toBe(false);
        expect(ready(config, config.videoModel)).toBe(false);
        expect(listVideoReferenceModels(config)).toEqual([]);
        expect(() => assertVideoConfig(resolveModelRequestConfig(config, config.videoModel), config.videoModel)).toThrow("请先连接 BeefTV");
    });

    test("manual provider keys stay required and are not treated as managed", () => {
        const ready = useConfigStore.getState().isAiConfigReady;
        const withKey = manualConfig("manual-secret");
        const withoutKey = manualConfig("");
        expect(ready(withKey, withKey.imageModel)).toBe(true);
        expect(ready(withKey, withKey.videoModel)).toBe(true);
        expect(listVideoReferenceModels(withKey)).toEqual([withKey.videoModel]);
        expect(ready(withoutKey, withoutKey.imageModel)).toBe(false);
        expect(listVideoReferenceModels(withoutKey)).toEqual([]);

        const spoofed = manualConfig("");
        spoofed.channels[0].credentialRef = MANAGED_BEEFAPI_CREDENTIAL_REF;
        spoofed.channels[0].hasApiKey = true;
        expect(ready(spoofed, spoofed.imageModel)).toBe(false);
        expect(listVideoReferenceModels(spoofed)).toEqual([]);
    });

    test("duplicate model names keep the selected channel credential in both orders", () => {
        const ready = useConfigStore.getState().isAiConfigReady;
        const sharedVideo = "seedance-2.0";
        const sharedAudio = "gpt-audio";
        const videoProfile = { model: sharedVideo, capability: "video" as const, protocol: "openai-videos" as const, capabilityConfig: videoCapability(sharedVideo) };
        const audioProfile = { model: sharedAudio, capability: "audio" as const, protocol: "openai-audio" as const };
        for (const order of ["manual-first", "beef-first"] as const) {
            const manualEmpty = createModelChannel({
                id: "manual",
                name: "工作室渠道",
                baseUrl: "https://api.example.com",
                apiKey: "",
                models: [sharedVideo, sharedAudio],
                modelProfiles: [videoProfile, audioProfile],
            });
            const manualKeyed = createModelChannel({
                ...manualEmpty,
                apiKey: "manual-secret",
            });
            const managed = createModelChannel({
                id: "beefapi",
                name: "BeefAPI",
                pinned: true,
                baseUrl: "https://enterprise.beefapi.com",
                apiKey: "",
                credentialRef: MANAGED_BEEFAPI_CREDENTIAL_REF,
                hasApiKey: true,
                models: [sharedVideo, sharedAudio],
                modelProfiles: [videoProfile, audioProfile],
            });
            const arrange = (manual: typeof manualEmpty): AiConfig => ({
                ...defaultConfig,
                channels: order === "manual-first" ? [manual, managed] : [managed, manual],
                videoModel: encodeChannelModel("beefapi", sharedVideo),
                audioModel: encodeChannelModel("beefapi", sharedAudio),
                model: encodeChannelModel("beefapi", sharedVideo),
            });
            const selectedManaged = arrange(manualEmpty);
            expect(ready(selectedManaged, selectedManaged.videoModel)).toBe(true);
            expect(ready(selectedManaged, selectedManaged.audioModel)).toBe(true);
            expect(() => assertVideoConfig(resolveModelRequestConfig(selectedManaged, selectedManaged.videoModel), selectedManaged.videoModel)).not.toThrow();
            expect(() => assertAudioConfig(resolveModelRequestConfig(selectedManaged, selectedManaged.audioModel), selectedManaged.audioModel)).not.toThrow();
            expect(resolveModelRequestConfig(selectedManaged, selectedManaged.videoModel).model).toBe(sharedVideo);

            const selectedManualEmpty = {
                ...selectedManaged,
                videoModel: encodeChannelModel("manual", sharedVideo),
                audioModel: encodeChannelModel("manual", sharedAudio),
                model: encodeChannelModel("manual", sharedVideo),
            };
            expect(ready(selectedManualEmpty, selectedManualEmpty.videoModel)).toBe(false);
            expect(ready(selectedManualEmpty, selectedManualEmpty.audioModel)).toBe(false);
            expect(() => assertVideoConfig(resolveModelRequestConfig(selectedManualEmpty, selectedManualEmpty.videoModel), selectedManualEmpty.videoModel)).toThrow("请先配置 API Key");
            expect(() => assertAudioConfig(resolveModelRequestConfig(selectedManualEmpty, selectedManualEmpty.audioModel), selectedManualEmpty.audioModel)).toThrow("请先配置 API Key");

            const selectedManualKeyed = arrange(manualKeyed);
            selectedManualKeyed.videoModel = encodeChannelModel("manual", sharedVideo);
            selectedManualKeyed.audioModel = encodeChannelModel("manual", sharedAudio);
            selectedManualKeyed.model = encodeChannelModel("manual", sharedVideo);
            expect(ready(selectedManualKeyed, selectedManualKeyed.videoModel)).toBe(true);
            expect(ready(selectedManualKeyed, selectedManualKeyed.audioModel)).toBe(true);
            expect(() => assertVideoConfig(resolveModelRequestConfig(selectedManualKeyed, selectedManualKeyed.videoModel), selectedManualKeyed.videoModel)).not.toThrow();
            expect(() => assertAudioConfig(resolveModelRequestConfig(selectedManualKeyed, selectedManualKeyed.audioModel), selectedManualKeyed.audioModel)).not.toThrow();
            expect(resolveModelRequestConfig(selectedManualKeyed, selectedManualKeyed.videoModel).model).toBe(sharedVideo);
        }
    });

    test("connected managed request config never exports the enterprise key", () => {
        const config = beefAPIConfig(true);
        config.channels[0].apiKey = "must-not-export";
        const resolved = resolveModelRequestConfig(config, config.imageModel);
        expect(resolved.apiKey).toBe("");
        expect(resolved.secretKey).toBe("");
        expect(resolved.credentialRef).toBe(MANAGED_BEEFAPI_CREDENTIAL_REF);
        expect(useConfigStore.getState().isAiConfigReady(config, config.imageModel)).toBe(true);
    });
});
