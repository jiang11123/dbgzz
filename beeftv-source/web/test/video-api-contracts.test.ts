import { describe, expect, test } from "bun:test";

import { defaultConfig } from "../src/stores/use-config-store";
import { createSeedanceTask } from "../src/services/api/video-provider-seedance";
import { createMiniMaxVideoTask } from "../src/services/api/video-provider-minimax";
import type { VideoProviderDeps } from "../src/services/api/video-provider-deps";
import { unwrapEnvelope, videoResponseTools, videoTaskId } from "../src/services/api/video-response";
import { isPublicMediaUrl, normalizeVideoResolution, normalizeVideoSeconds, normalizeVideoSize } from "../src/services/api/video-validation";

test("native Ark sends inline and asset audio, allowing audio-only only for 2.5", async () => {
    for (const protocol of ["volcengine-ark-video", "volcengine-ark-agent-plan-video"] as const) {
        let body: any;
        const deps = { transport: { post: async (_url: string, value: unknown) => { body = value; return { id: "task-native" }; } }, response: videoResponseTools } as unknown as VideoProviderDeps;
        const name = "doubao-seedance-2-5-260528";
        const config = { ...defaultConfig, model: name, videoModel: name, interfaceType: protocol, baseUrl: "https://ark.cn-beijing.volces.com/api/v3", videoSeconds: "30", channels: [{ id: "native", interfaceType: protocol, models: [name] }] };
        for (const url of ["data:audio/wav;base64,AAAA", "asset://voice", "https://example.com/audio.wav"]) {
            await createSeedanceTask(deps, config as never, name, "music", [], [], [{ id: "audio", name: "audio", type: "audio/wav", url, durationMs: 2000 }]);
            expect(body.content[1].audio_url.url).toBe(url);
            expect(body.duration).toBe(30);
        }
        await createSeedanceTask(deps, config as never, name, "music", [], [], [{ id: "audio", name: "audio", type: "audio/wav", url: "asset://opaque" }]);
        expect(body.content[1].audio_url.url).toBe("asset://opaque");
        await expect(createSeedanceTask(deps, config as never, name, "music", [], [], [{ id: "audio", name: "audio", type: "audio/wav", url: "asset://voice", durationMs: 1999 }])).rejects.toThrow("2–30");
        const oldName = "doubao-seedance-2-0-260128";
        const oldConfig = { ...config, model: oldName, videoModel: oldName, videoSeconds: "5", channels: [{ id: "native", interfaceType: protocol, models: [oldName] }] };
        await expect(createSeedanceTask(deps, oldConfig as never, oldName, "music", [], [], [{ id: "audio", name: "audio", type: "audio/wav", url: "asset://voice", durationMs: 2000 }])).rejects.toThrow("不支持只用音频");
    }
});

describe("video API response contracts", () => {
    test("解包裸响应和后端 envelope", () => {
        expect(unwrapEnvelope({ id: "task-1" }, "缺少任务")).toEqual({ id: "task-1" });
        expect(unwrapEnvelope({ code: 0, data: { id: "task-2" }, msg: "ok" }, "缺少任务")).toEqual({ id: "task-2" });
        expect(videoTaskId({ request_id: "request-1" })).toBe("request-1");
    });

    test("业务失败和空数据不会被静默转换为成功", () => {
        expect(() => unwrapEnvelope({ code: 401, data: null, msg: "未授权" }, "缺少任务")).toThrow("未授权");
        expect(() => unwrapEnvelope({ code: 0, data: null, msg: "ok" }, "缺少任务")).toThrow("缺少任务");
    });
});

describe("video request normalization", () => {
    test("规范化时长、比例尺寸和分辨率", () => {
        expect(normalizeVideoSeconds("0")).toBe("6");
        expect(normalizeVideoSeconds("8.9")).toBe("8");
        expect(normalizeVideoSize("16:9")).toBe("1280x720");
        expect(normalizeVideoSize("auto")).toBeNull();
        expect(normalizeVideoResolution("low")).toBe("480p");
        expect(normalizeVideoResolution("2k")).toBe("1440p");
    });

    test("只把 HTTP(S) 地址视为公网媒体地址", () => {
        expect(isPublicMediaUrl("https://cdn.example.com/video.mp4")).toBe(true);
        expect(isPublicMediaUrl("http://localhost/video.mp4")).toBe(true);
        expect(isPublicMediaUrl("asset://resource-1")).toBe(false);
        expect(isPublicMediaUrl("data:video/mp4;base64,AAAA")).toBe(false);
        expect(isPublicMediaUrl("/resources/video.mp4")).toBe(false);
    });
});

describe("Volcengine Ark full-modal references", () => {
    const model = "seedance-2-0-250824";
    const config = {
        ...defaultConfig,
        baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
        apiKey: "test-key",
        interfaceType: "volcengine-ark-video",
        channels: [
            {
                id: "ark",
                name: "Ark",
                baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
                apiKey: "test-key",
                secretKey: "",
                headers: [],
                apiFormat: "openai",
                interfaceType: "volcengine-ark-video",
                models: [model],
                scope: "user",
                enabled: true,
            },
        ],
    };

    test("映射图片、视频和音频参考素材", async () => {
        let requestUrl = "";
        let requestBody: unknown;
        const deps = {
            transport: {
                post: async (url: string, body: unknown) => {
                    requestUrl = url;
                    requestBody = body;
                    return { id: "task-1", status: "queued" };
                },
            },
            response: videoResponseTools,
        } as unknown as VideoProviderDeps;

        await createSeedanceTask(
            deps,
            config as never,
            model,
            "保持主体一致",
            [{ id: "image-1", name: "image.png", type: "image/png", dataUrl: "", url: "https://cdn.example.com/image.png" }],
            [{ id: "video-1", name: "video.mp4", type: "video/mp4", url: "https://cdn.example.com/video.mp4", durationMs: 3000, width: 720, height: 1280 }],
            [{ id: "audio-1", name: "audio.mp3", type: "audio/mpeg", url: "https://cdn.example.com/audio.mp3", durationMs: 3000 }],
        );

        expect(requestUrl).toBe("https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks");
        expect((requestBody as { content: unknown[] }).content).toEqual([
            { type: "text", text: "保持主体一致" },
            { type: "image_url", image_url: { url: "https://cdn.example.com/image.png" }, role: "reference_image" },
            { type: "video_url", video_url: { url: "https://cdn.example.com/video.mp4" }, role: "reference_video" },
            { type: "audio_url", audio_url: { url: "https://cdn.example.com/audio.mp3" }, role: "reference_audio" },
        ]);
    });

    test("拒绝纯音频和文本加音频", async () => {
        const deps = { transport: {}, response: videoResponseTools } as unknown as VideoProviderDeps;
        await expect(createSeedanceTask(deps, config as never, model, "跟随节奏", [], [], [{ id: "audio-1", name: "audio.mp3", type: "audio/mpeg", url: "https://cdn.example.com/audio.mp3", durationMs: 3000 }])).rejects.toThrow("不支持只用音频");
    });

    test("时长未知时在网络提交之前拒绝参考素材", async () => {
        let submitted = false;
        const deps = { transport: { post: async () => { submitted = true; return { id: "unexpected" }; } }, response: videoResponseTools } as unknown as VideoProviderDeps;
        await expect(createSeedanceTask(deps, config as never, model, "保持主体一致", [{id:"image",name:"image",type:"image/png",dataUrl:"",url:"https://cdn.example.com/image.png",width:512,height:512}], [], [{ id: "audio", name: "audio.mp3", type: "audio/mpeg", url: "https://cdn.example.com/audio.mp3" }])).rejects.toThrow("第 1 段参考音频的时长无法读取");
        expect(submitted).toBe(false);
    });

    test("显式首帧与项目角色参考图使用不同角色", async () => {
        let requestBody: unknown;
        const deps = {
            transport: { post: async (_url: string, body: unknown) => (requestBody = body, { id: "task-1" }) },
            response: videoResponseTools,
        } as unknown as VideoProviderDeps;
        const images = [
            { id: "character", name: "character.png", type: "image/png", dataUrl: "", url: "https://cdn.example.com/character.png" },
            { id: "start", name: "start.png", type: "image/png", dataUrl: "", url: "https://cdn.example.com/start.png" },
        ];

        await createSeedanceTask(deps, config as never, model, "开始运动", images, [], [], {
            videoEditOperation: "image_to_video",
            videoStartFrameNodeId: "start",
        });

        expect((requestBody as { content: unknown[] }).content).toContainEqual({
            type: "image_url",
            image_url: { url: "https://cdn.example.com/start.png" },
            role: "first_frame",
        });
        expect((requestBody as { content: unknown[] }).content).toContainEqual({
            type: "image_url",
            image_url: { url: "https://cdn.example.com/character.png" },
            role: "reference_image",
        });
    });
});

describe("Seedance /videos does not silently truncate references", () => {
    test("sends every validated reference image", async () => {
        let requestBody: Record<string, unknown> = {};
        const deps = {
            transport: { post: async (_url: string, body: unknown) => (requestBody = body as Record<string, unknown>, { id: "task-1" }) },
            response: videoResponseTools,
        } as unknown as VideoProviderDeps;
        const images = Array.from({ length: 12 }, (_, index) => ({
            id: `image-${index}`,
            name: `${index}.png`,
            type: "image/png",
            dataUrl: "",
            url: `https://cdn.example.com/${index}.png`,
            width: 800,
            height: 800,
        }));
        const config = {
            ...defaultConfig,
            baseUrl: "https://video.example.com/v1",
            model: "seedance-2.5",
            videoModel: "seedance-2.5",
            channels: [{ id: "default", models: ["seedance-2.5"], interfaceType: "openai", enabled: true, name: "t", apiKey: "k", secretKey: "", headers: [], apiFormat: "openai", baseUrl: "https://video.example.com/v1", scope: "user" }],
        };

        await createSeedanceTask(deps, config as never, "seedance-2.5", "保持角色一致", images, [], [], { videoEditOperation: "reference_to_video" });
        expect(requestBody.reference_image_urls).toHaveLength(12);
    });

    test("preserves requested 1080p, 2k, 20s and 30s in the payload", async () => {
        let requestBody: Record<string, unknown> = {};
        const deps = {
            transport: { post: async (_url: string, body: unknown) => (requestBody = body as Record<string, unknown>, { id: "task-1" }) },
            response: videoResponseTools,
        } as unknown as VideoProviderDeps;
        const image = { id: "image-1", name: "1.png", type: "image/png", dataUrl: "", url: "https://cdn.example.com/1.png", width: 800, height: 800 };
        const videosConfig = {
            ...defaultConfig,
            baseUrl: "https://video.example.com/v1",
            model: "seedance-2.5",
            videoModel: "seedance-2.5",
            videoSeconds: "20",
            vquality: "1080p",
            channels: [{ id: "default", models: ["seedance-2.5"], interfaceType: "openai", enabled: true, name: "t", apiKey: "k", secretKey: "", headers: [], apiFormat: "openai", baseUrl: "https://video.example.com/v1", scope: "user" }],
        };
        await createSeedanceTask(deps, videosConfig as never, "seedance-2.5", "开始运动", [image], [], []);
        expect(requestBody.duration).toBe(20);
        const planConfig = {
            ...videosConfig,
            baseUrl: "https://video.example.com/api/plan/v3",
            vquality: "1080p",
            videoSeconds: "20",
            channels: [{ ...videosConfig.channels[0], baseUrl: "https://video.example.com/api/plan/v3" }],
        };
        await createSeedanceTask(deps, { ...planConfig, vquality: "1080p", videoSeconds: "5" } as never, "seedance-2.0-fast", "开始运动", [image], [], []);
        expect(requestBody.resolution).toBe("1080p");
        expect(requestBody.duration).toBe(5);
        await createSeedanceTask(deps, { ...planConfig, vquality: "2k", videoSeconds: "30", model: "seedance-2.5" } as never, "seedance-2.5", "开始运动", [image], [], []);
        expect(requestBody.resolution).toBe("1440p");
        expect(requestBody.duration).toBe(30);
    });

    test("preserves explicit adaptive duration -1 when the catalog allows it", async () => {
        let requestBody: Record<string, unknown> = {};
        const deps = {
            transport: { post: async (_url: string, body: unknown) => (requestBody = body as Record<string, unknown>, { id: "task-1" }) },
            response: videoResponseTools,
        } as unknown as VideoProviderDeps;
        const image = { id: "image-1", name: "1.png", type: "image/png", dataUrl: "", url: "https://cdn.example.com/1.png", width: 800, height: 800 };
        const config = {
            ...defaultConfig,
            baseUrl: "https://video.example.com/v1",
            model: "seedance-2.5",
            videoSeconds: "-1",
            vquality: "720p",
            channels: [{
                id: "default",
                models: ["seedance-2.5"],
                interfaceType: "openai",
                enabled: true,
                name: "t",
                apiKey: "k",
                secretKey: "",
                headers: [],
                apiFormat: "openai",
                baseUrl: "https://video.example.com/v1",
                scope: "user",
                modelProfiles: [{
                    model: "seedance-2.5",
                    protocol: "openai",
                    capabilityConfig: {
                        version: 1,
                        video: {
                            references: { promptMaxChars: 8000, minImages: 0, maxImages: 9, maxImageBytes: 30 * 1024 * 1024, maxVideos: 3, maxVideoBytes: 1, maxVideoDurationSeconds: 15, maxAudios: 3, maxAudioBytes: 1, maxAudioDurationSeconds: 15 },
                            duration: { selection: "enum", values: [5, 10, -1], default: 5 },
                            ratios: ["16:9"],
                            defaultRatio: "16:9",
                            resolutions: ["720p", "1080p", "1440p"],
                            defaultResolution: "720p",
                            generateAudio: { supported: true, default: true },
                            watermark: { supported: false, default: false },
                            operations: ["text_to_video", "image_to_video"],
                            defaultOperation: "text_to_video",
                        },
                    },
                }],
            }],
        };
        await createSeedanceTask(deps, config as never, "seedance-2.5", "开始运动", [image], [], []);
        expect(requestBody.duration).toBe(-1);
    });

    test("local audio data URL and asset references stay in the payload", async () => {
        let requestBody: Record<string, unknown> = {};
        const deps = {
            transport: { post: async (_url: string, body: unknown) => (requestBody = body as Record<string, unknown>, { id: "task-1" }) },
            response: { ...videoResponseTools, blobToDataUrl: async () => "data:audio/mpeg;base64,AAAA" },
        } as unknown as VideoProviderDeps;
        const config = {
            ...defaultConfig,
            baseUrl: "https://video.example.com/v1",
            model: "seedance-2.5",
            videoModel: "seedance-2.5",
            videoSeconds: "5",
            channels: [{ id: "default", models: ["seedance-2.5"], interfaceType: "openai", enabled: true, name: "t", apiKey: "k", secretKey: "", headers: [], apiFormat: "openai", baseUrl: "https://video.example.com/v1", scope: "user" }],
        };
        await createSeedanceTask(deps, config as never, "seedance-2.5", "跟随节奏", [], [], [{ id: "audio-1", name: "a.mp3", type: "audio/mpeg", url: "data:audio/mpeg;base64,AAAA", durationMs: 3000, width: 720, height: 1280 }]);
        expect(requestBody.reference_audios).toEqual(["data:audio/mpeg;base64,AAAA"]);
        await createSeedanceTask(deps, config as never, "seedance-2.5", "跟随节奏", [], [], [{ id: "audio-2", name: "a.mp3", type: "audio/mpeg", url: "asset://voice", durationMs: 3000, width: 720, height: 1280 }]);
        expect(requestBody.reference_audios).toEqual(["asset://voice"]);
    });
});

describe("Seedance /videos image roles", () => {
    test("reference_to_video does not promote the first character image to image_url", async () => {
        let requestBody: Record<string, unknown> = {};
        const deps = {
            transport: { post: async (_url: string, body: unknown) => (requestBody = body as Record<string, unknown>, { id: "task-1" }) },
            response: videoResponseTools,
        } as unknown as VideoProviderDeps;
        const config = { ...defaultConfig, baseUrl: "https://video.example.com/v1", model: "seedance-2.0", videoModel: "seedance-2.0" };

        await createSeedanceTask(
            deps,
            config as never,
            "seedance-2.0",
            "保持角色一致",
            [
                { id: "character-1", name: "1.png", type: "image/png", dataUrl: "", url: "https://cdn.example.com/1.png" },
                { id: "character-2", name: "2.png", type: "image/png", dataUrl: "", url: "https://cdn.example.com/2.png" },
            ],
            [],
            [],
            { videoEditOperation: "reference_to_video" },
        );

        expect(requestBody.reference_image_urls).toEqual(["https://cdn.example.com/1.png", "https://cdn.example.com/2.png"]);
        expect(requestBody).not.toHaveProperty("image_url");
        expect(requestBody).not.toHaveProperty("image_urls");
    });
});

describe("MiniMax explicit reference roles", () => {
    test("project assets use reference_image and reference_audio instead of first frame", async () => {
        let requestBody: unknown;
        const deps = {
            transport: {
                post: async (_url: string, body: unknown) => {
                    requestBody = body;
                    return { task_id: "minimax-task-1" };
                },
            },
            response: videoResponseTools,
        } as unknown as VideoProviderDeps;
        const config = { ...defaultConfig, baseUrl: "https://api.minimaxi.com/v1", videoSeconds: "6", vquality: "768P", size: "16:9", videoWatermark: "false" };

        await createMiniMaxVideoTask(
            deps,
            config as never,
            "MiniMax-H3",
            "保持角色一致",
            [{ id: "character-1", name: "character.png", type: "image/png", dataUrl: "", url: "https://cdn.example.com/character.png" }],
            [],
            [{ id: "voice-1", name: "voice.mp3", type: "audio/mpeg", url: "https://cdn.example.com/voice.mp3" }],
            { videoEditOperation: "reference_to_video" },
        );

        expect((requestBody as { content: unknown[] }).content).toEqual([
            { type: "text", text: "保持角色一致" },
            { type: "image_url", image_url: { url: "https://cdn.example.com/character.png" }, role: "reference_image" },
            { type: "audio_url", audio_url: { url: "https://cdn.example.com/voice.mp3" }, role: "reference_audio" },
        ]);
        expect((requestBody as { ratio: string }).ratio).toBe("16:9");
    });
});
