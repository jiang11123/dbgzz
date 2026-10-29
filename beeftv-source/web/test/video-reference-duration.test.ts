import { expect, test } from "bun:test";
import { modelCapabilityConfigFor } from "../src/lib/model-capabilities";
import { assertReferenceDuration, assertVideoCapability } from "../src/services/api/video-validation";

test("duration bounds work independently and remain actionable after persistence", () => {
    expect(() => assertReferenceDuration("音频", 0, 16000, 0, 15)).toThrow("不超过 15");
    expect(() => assertReferenceDuration("音频", 0, 1000, 2, 0)).toThrow("至少 2");
    expect(() => assertReferenceDuration("音频", 0, undefined, 0, 0)).not.toThrow();
    expect(() => assertReferenceDuration("音频", 0, 15000, 0, 15)).not.toThrow();
    for (const [duration, min, max, bound] of [
        [16000, 0, 15, "不超过 15"],
        [1000, 2, 0, "至少 2"],
    ] as const) {
        try {
            assertReferenceDuration("音频", 0, duration, min, max);
        } catch (error) {
            const result = explainGenerationError(error);
            expect(result.category).toBe("invalid_params");
            expect(result.action).toContain(bound);
            expect(explainGenerationError(`${result.reason}。${result.action}。`).action).toContain(bound);
        }
    }
});

test("only backend task submissions defer missing owned resource metadata", () => {
    const profile = modelCapabilityConfigFor({ channels: [{ id: "test", interfaceType: "openai", models: ["seedance-2.5"] }] }, "test::seedance-2.5").video!;
    const media = { id: "voice", name: "voice", type: "audio/wav", storageKey: "resource:voice" };
    expect(() => assertVideoCapability(profile, [], [], [media], "5")).toThrow("时长无法读取");
    expect(() => assertVideoCapability(profile, [], [], [media], "5", { deferResourceMetadataToBackend: true })).not.toThrow();
    expect(() => assertVideoCapability(profile, [], [], [{ ...media, durationMs: 900 }], "5", { deferResourceMetadataToBackend: true })).toThrow("0.90");
});
import { explainGenerationError } from "../src/lib/generation-error";

const validImages = [{ id: "image", name: "参考图", type: "image/png", dataUrl: "", width: 512, height: 512 }];

for (const protocol of ["newapi-channel-2", "newapi", "openai"] as const) {
    for (const model of ["seedance-2.5", "provider/seedance-2.0-fast"]) {
        test(`${protocol} ${model}: real profiles reject short and unknown reference duration`, () => {
            const profile = modelCapabilityConfigFor(
                { channels: [{ id: "test", models: [model], baseUrl: protocol === "openai" ? "https://legacy.example.com" : "https://enterprise.beefapi.com", modelProfiles: [{ model, protocol }] }] },
                `test::${model}`,
            ).video!;
            const audio = (durationMs: number) => ({ id: "audio", name: "声音", type: "audio/mpeg", url: "https://example.com/a.mp3", durationMs });
            expect(() => assertVideoCapability(profile, validImages, [], [audio(2500), audio(900)], "5")).toThrow("第 2 段参考音频时长为 0.90 秒");
            expect(() => assertVideoCapability(profile, validImages, [], [audio(0)], "5")).toThrow("时长无法读取");
            expect(() => assertVideoCapability(profile, validImages, [], [audio(1700)], "5")).toThrow("1.70");
            expect(() => assertVideoCapability(profile, validImages, [], [audio(1800)], "5")).not.toThrow();
            const failure = explainGenerationError("第 2 段参考音频时长为 0.90 秒，需要 2–30 秒；请裁剪或更换这段素材后再提交");
            expect(failure.category).toBe("invalid_params");
            expect(failure.reason).toContain("第 2 段");
            expect(failure.action).toContain("2–30");
        });
    }
}

test("persisted material duration explanation keeps actionable limits", () => {
    const text = "参考素材时长不符合模型要求。请检查每段参考音频和视频，将不符合要求的素材调整为 1.8–30.2 秒后重新提交。";
    expect(explainGenerationError({ code: "invalid_params", message: text }).action).toContain("1.8–30.2");
});

test("catalog Seedance limits are not overwritten by official defaults", () => {
    const profile = modelCapabilityConfigFor(
        {
            channels: [
                {
                    id: "test",
                    models: ["seedance-2.5"],
                    modelProfiles: [
                        {
                            model: "seedance-2.5",
                            protocol: "newapi-channel-2",
                            capabilityConfig: {
                                version: 1,
                                video: {
                                    references: { promptMaxChars: 8000, minImages: 0, maxImages: 12, maxImageBytes: 1, maxVideos: 4, maxVideoBytes: 1, maxVideoDurationSeconds: 8, maxAudios: 5, maxAudioBytes: 1, maxAudioDurationSeconds: 8 },
                                    duration: { selection: "range", min: 1, max: 15, step: 1, default: 6 },
                                    ratios: ["16:9"],
                                    defaultRatio: "16:9",
                                    resolutions: ["720p"],
                                    defaultResolution: "720p",
                                    generateAudio: { supported: true, default: true },
                                    watermark: { supported: false, default: false },
                                    operations: ["text_to_video", "image_to_video"],
                                    defaultOperation: "text_to_video",
                                },
                            },
                        },
                    ],
                },
            ],
        } as never,
        "test::seedance-2.5",
    ).video!;
    expect(profile.references.maxImages).toBe(12);
    expect(profile.references.maxVideos).toBe(4);
    expect(profile.references.maxAudios).toBe(5);
    expect(profile.operations).not.toContain("audio_to_video");
    expect(profile.operations).not.toContain("reference_to_video");
});

test("enterprise catalog maxImages is not expanded to official 30", () => {
    const profile = modelCapabilityConfigFor(
        {
            channels: [
                {
                    id: "test",
                    models: ["seedance-2.5"],
                    modelProfiles: [
                        {
                            model: "seedance-2.5",
                            protocol: "newapi-channel-2",
                            capabilityConfig: {
                                version: 1,
                                video: {
                                    references: { promptMaxChars: 8000, minImages: 0, maxImages: 9, maxImageBytes: 1, maxVideos: 0, maxVideoBytes: 0, maxVideoDurationSeconds: 0, maxAudios: 0, maxAudioBytes: 0, maxAudioDurationSeconds: 0 },
                                    duration: { selection: "range", min: 1, max: 15, step: 1, default: 6 },
                                    ratios: ["16:9"],
                                    defaultRatio: "16:9",
                                    resolutions: ["720p"],
                                    defaultResolution: "720p",
                                    generateAudio: { supported: true, default: true },
                                    watermark: { supported: false, default: false },
                                    operations: ["text_to_video", "image_to_video"],
                                    defaultOperation: "text_to_video",
                                },
                            },
                        },
                    ],
                },
            ],
        } as never,
        "test::seedance-2.5",
    ).video!;
    expect(profile.references.maxImages).toBe(9);
    expect(profile.references.maxVideos).toBe(0);
    expect(profile.references.maxAudios).toBe(0);
});

test("image geometry and request size are checked before submit", () => {
    const profile = modelCapabilityConfigFor({ channels: [{ id: "test", interfaceType: "openai", models: ["seedance-2.5"] }] }, "test::seedance-2.5").video!;
    const image = (width: number, height: number, bytes: number) => ({ id: "img", name: "图", type: "image/png", dataUrl: "", width, height, bytes });
    expect(() => assertVideoCapability(profile, [image(200, 400, 1000)], [], [], "5")).toThrow("宽度为 200 像素");
    expect(() => assertVideoCapability(profile, [image(800, 800, 31 * 1024 * 1024)], [], [], "5")).toThrow("单文件");
    expect(() => assertVideoCapability(profile, [image(384, 216, 1000)], [], [], "5")).toThrow("调整尺寸或更换");
    const video = { id: "vid", name: "视频", type: "video/mp4", url: "https://example.com/large.mp4", width: 1280, height: 720, durationMs: 5000, bytes: 100 * 1024 * 1024 };
    expect(() => assertVideoCapability(profile, [], [video], [], "5")).not.toThrow();
});

test("legacy channel protocol without model profiles still applies Seedance duration limits", () => {
    const profile = modelCapabilityConfigFor({ channels: [{ id: "legacy", interfaceType: "openai", models: ["seedance-2.5"] }] }, "legacy::seedance-2.5").video!;
    expect(profile.references.minAudioDurationSeconds).toBe(1.8);
    expect(profile.references.maxAudioDurationSeconds).toBe(30);
});

for (const [model, maximum] of [
    ["seedance-2.0", 15],
    ["seedance-2.5", 30],
    ["provider/seedance-2.5", 30],
    ["seedance-2.5-self-developed", 30],
] as const) {
    test(`${model}: total audio duration is checked before submission`, () => {
        const profile = modelCapabilityConfigFor({ channels: [{ id: "test", interfaceType: "openai", models: [model] }] }, `test::${model}`).video!;
        const audio = (duration: number) => ({ id: "audio", name: "声音", type: "audio/mpeg", url: "https://example.com/a.mp3", durationMs: duration * 1000 });
        expect(() => assertVideoCapability(profile, validImages, [], [audio(maximum / 2), audio(maximum / 2)], "5")).not.toThrow();
        expect(() => assertVideoCapability(profile, validImages, [], [audio(maximum / 2), audio(maximum / 2 + 1)], "5")).toThrow(`最多支持 ${maximum} 秒`);
    });
}
