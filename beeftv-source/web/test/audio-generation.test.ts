import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

import { buildNodeConfig } from "@/components/canvas/canvas-node-prompt-panel";
import { audioSettingsSummary, audioSpeechProfile, buildAudioSpeechRequest, normalizeAudioFormatValue, normalizeAudioSpeedValue, normalizeAudioVoiceValue, resolveAudioSpeechSettings } from "@/lib/audio-generation";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { createModelChannel, defaultConfig, type AiConfig } from "@/stores/use-config-store";

function audioNode(patch: Partial<CanvasNodeData> = {}): CanvasNodeData {
    return {
        id: "audio-1",
        type: CanvasNodeType.Audio,
        title: "旁白",
        position: { x: 0, y: 0 },
        width: 320,
        height: 120,
        metadata: {},
        ...patch,
    };
}

function enterpriseConfig(): AiConfig {
    const channel = createModelChannel({
        id: "beefapi",
        name: "BeefAPI",
        baseUrl: "https://enterprise.beefapi.com",
        interfaceType: "openai-audio",
        models: ["minimax-speech-2.8-hd", "minimax-music-v3.0", "gpt-4o-mini-tts"],
        modelProfiles: [
            { model: "minimax-speech-2.8-hd", capability: "audio", protocol: "openai-audio" },
            { model: "minimax-music-v3.0", capability: "audio", protocol: "openai-audio" },
            { model: "gpt-4o-mini-tts", capability: "audio", protocol: "openai-audio" },
        ],
    });
    return {
        ...defaultConfig,
        channels: [channel],
        audioModel: "beefapi::minimax-speech-2.8-hd",
        audioVoice: "alloy",
        audioFormat: "mp3",
        audioSpeed: "1",
    };
}

describe("enterprise MiniMax speech settings", () => {
    test('blank speed stays 1 instead of clamping Number("") to the floor', () => {
        expect(normalizeAudioSpeedValue("", "minimax-speech-2.8-hd")).toBe("1");
        expect(normalizeAudioSpeedValue("  ", "gpt-4o-mini-tts")).toBe("1");
        expect(resolveAudioSpeechSettings("minimax-speech-2.8-hd", {}).audioSpeed).toBe("1");
        expect(normalizeAudioSpeedValue("0", "minimax-speech-2.8-hd")).toBe("1");
        expect(normalizeAudioSpeedValue("1.25", "minimax-speech-2.8-hd")).toBe("1.25");
    });

    test("MiniMax formats follow the native adapter, not OpenAI-only opus", () => {
        expect(audioSpeechProfile("minimax-speech-2.8-hd").formats.map((item) => item.value)).toEqual(["mp3", "wav", "aac", "flac", "pcm"]);
        expect(audioSpeechProfile("minimax-music-v3.0").formats.map((item) => item.value)).toEqual(["mp3"]);
        expect(normalizeAudioFormatValue("flac", "minimax-music-v3.0")).toBe("mp3");
        expect(audioSettingsSummary({ model: "minimax-music-v3.0", audioFormat: "flac" })).toBe("MP3 · 256 kbps");
        expect(audioSpeechProfile("gpt-4o-mini-tts").formats.map((item) => item.value)).toContain("opus");
        expect(normalizeAudioFormatValue("opus", "minimax-speech-2.8-hd")).toBe("mp3");
    });

    test("does not coerce MiniMax voices onto OpenAI alloy", () => {
        expect(normalizeAudioVoiceValue("alloy", "beefapi::minimax-speech-2.8-hd")).toBe("male-qn-qingse");
        expect(normalizeAudioVoiceValue("中文", "minimax-speech-2.8-hd")).toBe("male-qn-qingse");
        expect(normalizeAudioVoiceValue("male-qn-jingying", "minimax-speech-2.8-hd")).toBe("male-qn-jingying");
        expect(normalizeAudioVoiceValue("cloned-voice-abc", "minimax-speech-2.8-hd")).toBe("cloned-voice-abc");
        expect(normalizeAudioVoiceValue("alloy", "gpt-4o-mini-tts")).toBe("alloy");
    });

    test("summary and payload follow the speech contract instead of 中文 · 24k · wav", () => {
        const settings = resolveAudioSpeechSettings("beefapi::minimax-speech-2.8-hd", {
            audioVoice: "alloy",
            audioFormat: "mp3",
            audioSpeed: "1",
        });
        expect(audioSettingsSummary({ model: "beefapi::minimax-speech-2.8-hd", ...settings })).toBe("青涩青年 · MP3 · 1x");
        expect(audioSettingsSummary({ model: "beefapi::minimax-speech-2.8-hd", ...settings })).not.toContain("24k");
        expect(audioSettingsSummary({ model: "beefapi::minimax-speech-2.8-hd", ...settings })).not.toContain("中文");
        expect(buildAudioSpeechRequest({ model: "minimax-speech-2.8-hd", ...settings }, "大家好")).toEqual({
            model: "minimax-speech-2.8-hd",
            input: "大家好",
            voice: "male-qn-qingse",
            response_format: "mp3",
            speed: 1,
        });
    });

    test("helper music payload omits voice; OpenAI TTS keeps alloy and instructions", () => {
        expect(buildAudioSpeechRequest({ model: "minimax-music-v3.0", audioFormat: "mp3" }, "轻快的钢琴")).toEqual({
            model: "minimax-music-v3.0",
            input: "轻快的钢琴",
            response_format: "mp3",
            metadata: { audio_setting: { sample_rate: 44100, bitrate: 256000, format: "mp3" } },
        });
        expect(
            buildAudioSpeechRequest(
                {
                    model: "gpt-4o-mini-tts",
                    audioVoice: "alloy",
                    audioFormat: "wav",
                    audioSpeed: "1.25",
                    audioInstructions: "温暖旁白",
                },
                "hello",
            ),
        ).toEqual({
            model: "gpt-4o-mini-tts",
            input: "hello",
            voice: "alloy",
            response_format: "wav",
            speed: 1.25,
            instructions: "温暖旁白",
        });
    });

    test("canvas node config remaps enterprise speech defaults for the selected model", () => {
        const config = buildNodeConfig(enterpriseConfig(), audioNode(), "audio", { capability: "audio" });
        expect(config.model).toContain("minimax-speech-2.8-hd");
        expect(config.audioVoice).toBe("male-qn-qingse");
        expect(config.audioFormat).toBe("mp3");
        expect(audioSettingsSummary(config)).toBe("青涩青年 · MP3 · 1x");
    });

    test("prompt panel no longer overlays a fake Seed Audio summary", () => {
        const source = readFileSync(new URL("../src/components/canvas/canvas-node-prompt-panel.tsx", import.meta.url), "utf8");
        expect(source).not.toContain("中文 · 24k · wav");
        expect(source).not.toContain('summaryOverride={localOnly ? "中文');
    });
});
