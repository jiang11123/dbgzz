import { describe, expect, test } from "bun:test";

import { defaultProtocolForModel, ensureModelProfilesWithUiDefaults, inferProtocolCapabilityFromModel } from "@/lib/model-protocols";
import { createModelChannel, defaultConfig, resolveModelRequestConfig } from "@/stores/use-config-store";

describe("manual channel protocol defaults", () => {
    test("video models without an explicit protocol stay unconfigured through both list editing and submission", () => {
        for (const profiles of [undefined, [{ model: "seedance-2.5", capability: "video" as const }]]) {
            const next = ensureModelProfilesWithUiDefaults(["seedance-2.5"], profiles);
            expect(next[0]?.protocol).toBeUndefined();
            const channel = createModelChannel({ id: "external", baseUrl: "https://third-party.example/v1", models: ["seedance-2.5"], modelProfiles: profiles });
            expect(resolveModelRequestConfig({ ...defaultConfig, channels: [channel] }, "external::seedance-2.5").interfaceType).toBeUndefined();
        }
        const selected = createModelChannel({ id: "external", interfaceType: "video-generations-json", models: ["seedance-2.5"], modelProfiles: ensureModelProfilesWithUiDefaults(["seedance-2.5"], undefined) });
        expect(resolveModelRequestConfig({ ...defaultConfig, channels: [selected] }, "external::seedance-2.5").interfaceType).toBe("video-generations-json");
    });
    test.each(["gemini-generate-content", "google-gemini-generate-content"])("managed Gemini protocol %s preserves credentials and selects native transport", (protocol) => {
        const channel = createModelChannel({
            id: "beefapi", pinned: true, credentialRef: "beefapi-enterprise", hasApiKey: true,
            baseUrl: "https://example.invalid", apiKey: "must-not-forward", apiFormat: "openai",
            models: ["gemini-test"], modelProfiles: [{ model: "gemini-test", capability: "text", protocol }],
        });
        const resolved = resolveModelRequestConfig({ ...defaultConfig, channels: [channel] }, "beefapi::gemini-test");
        expect(resolved.interfaceType).toBe("gemini-generate-content");
        expect(resolved.apiFormat).toBe("gemini");
        expect(resolved.apiKey).toBe("");
        expect(resolved.credentialRef).toBe("beefapi-enterprise");
    });
    test("typed gpt-4.1-mini uses the same Chat Completions default the settings radio shows", () => {
        expect(inferProtocolCapabilityFromModel("gpt-4.1-mini")).toBe("text");
        expect(defaultProtocolForModel("gpt-4.1-mini")).toBe("chat-completion");

        const channel = createModelChannel({
            id: "manual",
            name: "QA故障回归",
            baseUrl: "https://qa-beeftv.invalid/v1",
            apiKey: "fakekey",
            apiFormat: "openai",
            models: ["gpt-4.1-mini"],
        });
        const config = {
            ...defaultConfig,
            channels: [channel],
            model: "manual::gpt-4.1-mini",
            textModel: "manual::gpt-4.1-mini",
            models: ["manual::gpt-4.1-mini"],
            textModels: ["manual::gpt-4.1-mini"],
        };
        const resolved = resolveModelRequestConfig(config, config.textModel);
        expect(resolved.channelId).toBe("");
        expect(resolved.interfaceType).toBe("chat-completion");
        expect(resolved.model).toBe("gpt-4.1-mini");
    });

    test("adding a typed model persists the UI default without overwriting an explicit protocol", () => {
        const existing = [{ model: "kept-response", capability: "text" as const, protocol: "openai-response" as const }];
        const profiles = ensureModelProfilesWithUiDefaults(["kept-response", "gpt-4.1-mini"], existing);
        expect(profiles).toEqual([expect.objectContaining({ model: "kept-response", protocol: "openai-response" }), expect.objectContaining({ model: "gpt-4.1-mini", capability: "text", protocol: "chat-completion" })]);
    });

    test("manual MiniMax speech and music names are audio, not video", () => {
        expect(inferProtocolCapabilityFromModel("minimax-speech-2.8-hd")).toBe("audio");
        expect(defaultProtocolForModel("minimax-speech-2.8-hd")).toBe("openai-audio");
        expect(inferProtocolCapabilityFromModel("minimax-music-2.0")).toBe("audio");
        expect(defaultProtocolForModel("minimax-music-2.0")).toBe("openai-audio");
        expect(ensureModelProfilesWithUiDefaults(["minimax-speech-2.8-hd", "minimax-music-2.0"], undefined)).toEqual([
            expect.objectContaining({ model: "minimax-speech-2.8-hd", capability: "audio", protocol: "openai-audio" }),
            expect.objectContaining({ model: "minimax-music-2.0", capability: "audio", protocol: "openai-audio" }),
        ]);
    });

    test("manual MiniMax text names stay text", () => {
        expect(inferProtocolCapabilityFromModel("minimax-m2")).toBe("text");
        expect(defaultProtocolForModel("minimax-m2")).toBe("chat-completion");
        expect(ensureModelProfilesWithUiDefaults(["minimax-m2"], undefined)).toEqual([expect.objectContaining({ model: "minimax-m2", capability: "text", protocol: "chat-completion" })]);
    });

    test("explicit capability is kept when protocol is missing", () => {
        const profiles = ensureModelProfilesWithUiDefaults(["custom-voice"], [{ model: "custom-voice", capability: "audio" }]);
        expect(profiles).toEqual([expect.objectContaining({ model: "custom-voice", capability: "audio", protocol: "openai-audio" })]);
        const channel = createModelChannel({
            id: "manual",
            name: "QA",
            apiKey: "fakekey",
            models: ["custom-voice"],
            modelProfiles: [{ model: "custom-voice", capability: "audio" }],
        });
        expect(resolveModelRequestConfig({ ...defaultConfig, channels: [channel], model: "manual::custom-voice" }, "manual::custom-voice").interfaceType).toBe("openai-audio");
    });

    test("gpt-image names stay image", () => {
        expect(inferProtocolCapabilityFromModel("gpt-image-1")).toBe("image");
        expect(defaultProtocolForModel("gpt-image-1")).toBe("openai-image");
    });

    test("Gemini channels keep apiFormat and do not invent Chat Completions", () => {
        const channel = createModelChannel({
            id: "reasoning",
            name: "Reasoning",
            baseUrl: "https://reasoning.example/v1",
            apiKey: "synthetic-test-key",
            apiFormat: "gemini",
            models: ["reasoner"],
            modelProfiles: [{ model: "reasoner", capability: "text", billingMode: "fixed_request", unitPriceMicrocredits: 0 }],
        });
        const resolved = resolveModelRequestConfig({ ...defaultConfig, channels: [channel], model: "reasoning::reasoner", textModel: "reasoning::reasoner" }, "reasoning::reasoner");
        expect(resolved.apiFormat).toBe("gemini");
        expect(resolved.interfaceType).toBeUndefined();
        expect(ensureModelProfilesWithUiDefaults(["reasoner"], [{ model: "reasoner", capability: "text" }], [], "gemini")).toEqual([expect.objectContaining({ model: "reasoner", capability: "text", protocol: undefined })]);
    });
});
