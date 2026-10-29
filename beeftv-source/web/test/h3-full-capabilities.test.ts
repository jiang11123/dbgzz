import { expect, test } from "bun:test";
import { h3Duration, h3GenerationControls, h3MediaPayload, h3ResolvedReferenceOrder, isH3Style } from "../src/lib/h3-video";
import { H3DirectorControl, h3DirectorConfigure } from "../src/lib/h3-director";
import { sanitizeServerVideoCapability, normalizeVideoValue, videoDurationAllowed } from "../src/lib/model-capabilities";

test("fractional catalog survives server ingestion and canvas normalization", () => {
    const profile = sanitizeServerVideoCapability({
        references: { promptMaxChars: 50000, minImages: 0, maxImages: 9, maxImageBytes: 31457280, maxVideos: 3, maxAudios: 3 },
        duration: { selection: "range", min: 1, fractionalMin:0.92, max: 15, step: 1, default: 5, continuous: true },
        ratios: ["16:9"],
        defaultRatio: "16:9",
        resolutions: ["768p"],
        defaultResolution: "768p",
        generateAudio: { supported: false, default: true },
        watermark: { supported: false, default: false },
        operations: ["text_to_video", "reference_to_video"],
        defaultOperation: "text_to_video",
    });
    expect(profile).not.toBeNull();
    expect(normalizeVideoValue(profile!, { seconds: "0.925", ratio: "16:9", resolution: "768p" }).seconds).toBe("0.925");
    expect(videoDurationAllowed(profile!, 0.925)).toBe(true);
});

test("H3 exact fractional seconds and explicit false/zero survive controls", () => {
    expect(h3Duration("minimax-h3-max", "0.925")).toBe("0.925");
    expect(h3GenerationControls("minimax-h3-max", { seed: 0, enable_safety_checker: false, sync_mode: true })).toMatchObject({ seed: 0, enable_safety_checker: true, sync_mode: false, prompt_expansion_mode: "balanced" });
    expect(() => h3Duration("minimax-h3", "5.5")).toThrow();
    expect(() => h3Duration("minimax-h3-max", "0.91")).toThrow();
    expect(() => h3GenerationControls("minimax-h3-max", { prompt_expansion_mode: "fast" })).toThrow();
});

test("Max mixed frames retain cross-modality reference ordering", () => {
    const media = [
        { id: "start", type: "image" as const, url: "https://example.com/start" },
        { id: "end", type: "image" as const, url: "https://example.com/end" },
        { id: "mid", type: "image" as const, url: "https://example.com/mid" },
        { id: "subject", type: "image" as const, url: "https://example.com/subject" },
        { id: "video", type: "video" as const, url: "https://example.com/video" },
        { id: "voice", type: "audio" as const, url: "https://example.com/voice" },
    ];
    const options = { videoEditOperation: "reference_to_video", videoStartFrameNodeId: "start", videoEndFrameNodeId: "end", videoMiddleFrameNodeId: "mid", videoMiddleFrameTime: 2.5, videoReferenceOrder: ["voice", "subject", "video"] };
    const { payload } = h3MediaPayload("minimax-h3-max", media, options, 5, "768p");
    expect(payload.reference_conditions).toEqual([
        { type: "audio", url: "https://example.com/voice" },
        { type: "image", url: "https://example.com/subject" },
        { type: "video", url: "https://example.com/video" },
    ]);
    expect(payload.reference_image_urls).toBeUndefined();
    expect(payload.middle_frame_time).toBe(2.5);
    expect(() => h3MediaPayload("minimax-h3-max-turbo", media, options, 5, "768p")).toThrow();
    expect(() => h3MediaPayload("minimax-h3-max", media, options, 5, "1080p")).toThrow();
    expect(() => h3MediaPayload("minimax-h3-max", media, { ...options, videoMiddleFrameTime: 5 }, 5, "768p")).toThrow();
});

test("saved card order expands to actual image and voice ids before H3 submission", () => {
    const media = [
        { id: "scene", type: "image" as const, url: "https://example.com/scene" },
        { id: "character-reference-1", sourceNodeId: "card", type: "image" as const, url: "https://example.com/front" },
        { id: "character-reference-2", sourceNodeId: "card", type: "image" as const, url: "https://example.com/side" },
        { id: "motion", type: "video" as const, url: "https://example.com/motion" },
        { id: "character-voice-asset", sourceNodeId: "card", type: "audio" as const, url: "https://example.com/voice" },
        { id: "extra", type: "audio" as const, url: "https://example.com/extra" },
    ];
    const order = h3ResolvedReferenceOrder(["motion", "card", "scene", "connected-but-not-mentioned"], media);
    expect(order).toEqual(["motion", "character-reference-1", "character-reference-2", "character-voice-asset", "scene", "extra"]);
    const { payload } = h3MediaPayload("minimax-h3-max", media, { videoEditOperation: "reference_to_video", videoReferenceOrder: order });
    expect(payload.reference_conditions).toEqual([
        { type: "video", url: "https://example.com/motion" },
        { type: "image", url: "https://example.com/front" },
        { type: "image", url: "https://example.com/side" },
        { type: "audio", url: "https://example.com/voice" },
        { type: "image", url: "https://example.com/scene" },
        { type: "audio", url: "https://example.com/extra" },
    ]);
    expect(h3ResolvedReferenceOrder(undefined, media)).toBeUndefined();
});

test("Styles only transmit supported controls including VHS damage", () => {
    expect(isH3Style("minimax-h3-max-style-vhs")).toBe(true);
    expect(isH3Style("minimax-h3-max-style-vhs-extra")).toBe(false);
    expect(h3GenerationControls("minimax-h3-max-style-vhs", { seed: 0, enable_safety_checker: false, sync_mode: true, damage_level: "heavy" })).toEqual({ seed: 0, damage_level: "heavy" });
    expect(h3GenerationControls("minimax-h3-max-style-hand-drawn", { seed: 0 })).toEqual({ seed: 0 });
    expect(() => h3MediaPayload("minimax-h3-max-style-vhs", [{ id: "voice", type: "audio", url: "https://example.com/voice" }])).toThrow();
});

test("Director requires matching configure acknowledgement and never replays terminal sessions", () => {
    const sent: object[] = [];
    const session = new H3DirectorControl((m) => sent.push(m));
    session.configure({ prompt: "Continuous scene", seed: 0, audio_bitrate: 192000, memory: 50 });
    expect(sent[0]).toMatchObject({ type: "configure", prompt_version: 1, seed: 0 });
    expect(() => session.update({ prompt: "Turn left" })).toThrow();
    session.accept({ type: "configured", prompt_version: 2 });
    expect(() => session.update({ prompt: "Turn left" })).toThrow();
    session.accept({ type: "configured", prompt_version: 1 });
    session.update({ prompt: "Turn left", replan: false });
    session.update({ audio_url: "https://example.com/audio", audio_behavior: "queue" });
    expect(sent[1]).toMatchObject({ prompt_version: 2, replan: false });
    expect(sent[2]).toMatchObject({ prompt_version: 3, audio_behavior: "queue" });
    session.accept({ type: "stream_exhausted", reason: "session_limit" });
    expect(() => session.update({ prompt: "Continue" })).toThrow();
    expect(sent).toHaveLength(3);
});

test("Director scripts validate exclusivity, offsets and endpoint spacing", () => {
    expect(
        h3DirectorConfigure({
            prompt: "Story",
            script: [
                { offset: 0, prompt: "Opening" },
                { offset: 3, end_image_url: "https://example.com/end" },
            ],
        }),
    ).toMatchObject({
        script: [
            { offset: 0, prompt: "Opening" },
            { offset: 3, end_image_url: "https://example.com/end" },
        ],
    });
    expect(() => h3DirectorConfigure({ prompt: "Story", script: [{ offset: 0, prompt: "Opening" }], audio_url: "https://example.com/audio" })).toThrow();
    expect(() =>
        h3DirectorConfigure({
            prompt: "Story",
            script: [
                { offset: 2, prompt: "A" },
                { offset: 1, prompt: "B" },
            ],
        }),
    ).toThrow();
    expect(() =>
        h3DirectorConfigure({
            prompt: "Story",
            script: [
                { offset: 0, end_image_url: "https://example.com/a" },
                { offset: 2, end_image_url: "https://example.com/b" },
            ],
        }),
    ).toThrow();
});
