import { describe, expect, test } from "bun:test";
import { inferVideoHasAudio } from "../src/lib/canvas/canvas-media-preview";
import { mediaResultMetadata, normalizeCanvasMediaNodeSemantics } from "../src/lib/canvas/canvas-node-semantics";
import { normalizeVideoBoolean, parseVideoBoolean } from "../src/lib/video-generation-options";
import { resolveModelGenerationDefaults } from "../src/lib/model-selection";
import { defaultConfig, normalizeConfigSnapshot } from "../src/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeMetadata } from "../src/types/canvas";

// Exercise JSON at the boundary, where the static string annotation cannot protect us.
function metadata(value: unknown): CanvasNodeMetadata {
    return JSON.parse(JSON.stringify({ generateAudio: value, content: "https://example.test/video.mp4" }));
}

describe("video audio setting at JSON boundaries", () => {
    test("restoring persisted video switches preserves false before generation", () => {
        for (const value of [true, false, "true", "false"]) {
            const saved = JSON.parse(JSON.stringify({ config: { videoGenerateAudio: value, videoWatermark: value, videoArkPrivateAssetUpload: value } }));
            const restored = normalizeConfigSnapshot(saved).config;
            expect(restored.videoGenerateAudio).toBe(String(value));
            expect(restored.videoWatermark).toBe(String(value));
            expect(restored.videoArkPrivateAssetUpload).toBe(String(value));
        }
    });
    for (const [expected, values] of [
        [true, [true, "true", " TRUE ", "1", 1, "yes", "on", "enabled"]],
        [false, [false, "false", " FALSE ", "0", 0, "no", "off", "disabled"]],
    ] as const) {
        for (const value of values) {
            test(`plays persisted ${JSON.stringify(value)} without changing its meaning`, () => {
                const saved = metadata(value);
                expect(inferVideoHasAudio(saved)).toBe(expected);
                const node: CanvasNodeData = { id: "video", type: CanvasNodeType.Video, title: "video", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: saved };
                const normalized = normalizeCanvasMediaNodeSemantics(node);
                expect(normalized.metadata?.generateAudio).toBe(String(expected));
                expect(saved.generateAudio as unknown).toBe(value);
                expect(normalizeCanvasMediaNodeSemantics(normalized)).toBe(normalized);
                const reopened = JSON.parse(JSON.stringify(normalized));
                expect(inferVideoHasAudio(reopened.metadata)).toBe(expected);
                expect(mediaResultMetadata("generated", saved).generateAudio).toBe(String(expected));
            });
        }
    }

    test("unknown values do not crash or falsely disable audio", () => {
        for (const value of [null, undefined, {}, [], ["false"], 2, "", "unknown"]) {
            expect(parseVideoBoolean(value)).toBeUndefined();
            expect(normalizeVideoBoolean(value)).toBeUndefined();
            expect(inferVideoHasAudio(metadata(value))).toBeUndefined();
        }
    });

    test("observed audio tracks take precedence over generation settings", () => {
        expect(inferVideoHasAudio({ ...metadata(false), hasAudio: true })).toBe(true);
        expect(inferVideoHasAudio({ ...metadata(true), hasAudio: false })).toBe(false);
        expect(inferVideoHasAudio({ ...metadata(true), hasAudio: true, workflowKind: "reference_video", assetTags: ["导演台白膜"] })).toBe(false);
        expect(inferVideoHasAudio(undefined)).toBeUndefined();
    });

    test("generation defaults canonicalize boolean JSON before persisting a result", () => {
        for (const value of [true, false]) {
            const explicit = JSON.parse(JSON.stringify({ videoGenerateAudio: value }));
            const defaults = resolveModelGenerationDefaults(defaultConfig, "seedance-2.0", "video", explicit);
            expect(defaults.videoGenerateAudio).toBe(String(value));
            expect(inferVideoHasAudio(mediaResultMetadata("generated", { generateAudio: defaults.videoGenerateAudio }))).toBe(value);
        }
    });
});
