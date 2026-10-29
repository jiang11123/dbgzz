import { expect, test } from "bun:test";
import { seedanceTaskOptions } from "../src/lib/seedance-task-constraints";
import { explainGenerationError } from "../src/lib/generation-error";
import { resolveVideoOperation } from "../src/lib/model-selection";
import { createSeedanceTask, pollSeedanceTask } from "../src/services/api/video-provider-seedance";
import { defaultConfig } from "../src/stores/use-config-store";
import { videoResponseTools } from "../src/services/api/video-response";
import type { VideoProviderDeps } from "../src/services/api/video-provider-deps";

test("frontend native and compatible requests retain the first-frame constraint", async () => {
    for (const protocol of ["volcengine-ark-video", "newapi-channel-2"] as const) {
        let body: any;
        const deps = {
            transport: {
                post: async (_url: string, value: unknown) => {
                    body = value;
                    return { id: "task-native" };
                },
            },
            response: videoResponseTools,
        } as unknown as VideoProviderDeps;
        const model = "seedance-2.5-official";
        const config = {
            ...defaultConfig,
            model,
            videoModel: model,
            interfaceType: protocol,
            baseUrl: protocol === "volcengine-ark-video" ? "https://ark.cn-beijing.volces.com/api/v3" : "https://example.com/v1",
            size: "9:16",
            videoSeconds: "6",
            channels: [{ id: "test", interfaceType: protocol, models: [model] }],
        };
        const refs = [{ id: "first", name: "first.png", type: "image/png", dataUrl: "", url: "https://example.com/first.png", width: 512, height: 512 }];
        await createSeedanceTask(deps, config as never, model, "move", refs, [], []);
        expect(body.ratio || body.aspect_ratio).toBe("adaptive");
        expect(body.duration).toBe(6);
        await createSeedanceTask(deps, config as never, model, "move", refs, [], [], { videoEditOperation: "reference_to_video" });
        expect(body.ratio || body.aspect_ratio).toBe("9:16");
        expect(body.omni_reference_task_type).toBe("reference");
    }
});

test("Seedance 2.5 locks explicit task options and preserves semantic reference", () => {
    for (const model of ["seedance-2.5", "seedance-2.5-official", "doubao-seedance-2-5-260628"]) {
        expect(seedanceTaskOptions(model, "9:16", 6, ["first_frame"], 0)).toEqual({ ratio: "adaptive", duration: 6 });
        expect(seedanceTaskOptions(model, "9:16", 6, ["reference_image"], 1, "reference_to_video")).toEqual({ ratio: "9:16", duration: 6 });
        expect(seedanceTaskOptions(model, "9:16", 6, [], 1, "inpaint")).toEqual({ ratio: "adaptive", duration: -1 });
        expect(seedanceTaskOptions(model, "9:16", 6, [], 1, "extend")).toEqual({ ratio: "adaptive", duration: 6 });
    }
    expect(seedanceTaskOptions("seedance-2.0", "9:16", 6, ["first_frame"], 0)).toEqual({ ratio: "9:16", duration: 6 });
});

test("nested upstream TaskTypeConstraint explains how to correct the mode", () => {
    const raw = {
        error: {
            code: "upstream_error",
            message: JSON.stringify({
                code: "fail_to_fetch_task",
                message: "InvalidParameter.TaskTypeConstraint: The parameter ratio specified in the request is not valid. For first-frame or first-last-frame generation, the output ratio follows the first-frame image",
            }),
        },
    };
    const error = explainGenerationError(raw);
    expect(error.category).toBe("invalid_params");
    expect(error.reason).toBe("首尾帧模式的画面比例需跟随首帧");
    expect(error.action).toContain("自适应");
    expect(error.blockAutomaticRetry).toBe(true);
    const readback = explainGenerationError(error.message);
    expect(readback.category).toBe(error.category);
    expect(readback.reason).toBe(error.reason);
    expect(readback.action).toBe(error.action);
    expect(explainGenerationError({ code: "invalid_params", message: error.message }).reason).toBe(error.reason);
    const persisted = `${error.message}排查编号：请求 req_task_constraint_123。`;
    expect(explainGenerationError({ code: "invalid_params", message: persisted }).requestId).toBe("req_task_constraint_123");
    expect(explainGenerationError({ code: "invalid_params", message: persisted, request_id: "req_outer_456" }).requestId).toBe("req_outer_456");
});

test("explicit reference and extension intent survives model selection", () => {
    const input = { imageCount: 1, characterCount: 0, videoCount: 0, audioCount: 0 };
    expect(resolveVideoOperation(input, "reference_to_video")).toBe("reference_to_video");
    expect(resolveVideoOperation({ ...input, videoCount: 1 }, "extend")).toBe("extend");
    expect(resolveVideoOperation({ ...input, videoCount: 1 })).toBe("reference_to_video");
});

test("temporary unavailable error inside failed task is actionable", () => {
 const e=explainGenerationError({error:{code:"model_temporarily_unavailable",message:"无可用线路：当前售价档位 standard 暂无可用线路"}});
 expect(e.category).toBe("provider_unavailable"); expect(e.reason).toBe("模型服务暂时不可用");
});


test("polling preserves unavailable code over ambiguous provider prose", async () => {
    for (const message of ["无可用线路：当前售价档位 standard 暂无可用线路，线路可能维护中或模型不存在", undefined]) {
        const deps = {
            transport: { get: async () => ({ status: "failed", error: { code: "model_temporarily_unavailable", message } }) },
            response: { ...videoResponseTools, unwrapSeedanceTask: (value: unknown) => value },
        } as unknown as VideoProviderDeps;
        const config = { ...defaultConfig, baseUrl: "https://example.com/v1" };
        const result = await pollSeedanceTask(deps, config as never, { id: "task-failed", provider: "seedance", model: "seedance-2.5" });
        expect(result.status).toBe("failed");
        if (result.status !== "failed") throw new Error("expected failed task");
        const failure = explainGenerationError(result.error);
        expect(failure.category).toBe("provider_unavailable");
        expect(explainGenerationError(failure.message).category).toBe("provider_unavailable");
    }
});
