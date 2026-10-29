import { describe, expect, test } from "bun:test";
import { buildNodeGenerationContext } from "../src/components/canvas/canvas-node-generation";
import { canvasGenerationFailureMetadata, canvasGenerationRetryBlocked, canvasTaskFailureMetadata } from "../src/pages/canvas/canvas-generation-failure";
import { taskAttentionReason, taskRetryBlocked } from "../src/pages/tasks/task-shared";
import { resolveMetadataReferences, generationTaskMetadata, resetGenerationTaskMetadata } from "../src/lib/canvas/canvas-project-generation";
import { ApiError } from "../src/services/api/request";
import { explainGenerationError, formatGenerationDiagnostics } from "../src/lib/generation-error";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";
import type { GenerationTask } from "../src/services/api/task-center";
import moderationFixtures from "../../fixtures/moderation-errors.json";

const rejection = { code: "content_policy_violation", message: "opaque" };

test("confirmed unsent submission remains retryable after restoring the task", () => {
    const task = { id: "unsent-task", type: "canvas_video", status: "failed", stage: "任务失败", errorCode: "request_not_sent", error: "未能连接服务，本次请求尚未提交。请检查网络或代理后重试。" } as GenerationTask;
    const metadata = { ...generationTaskMetadata(task), ...canvasTaskFailureMetadata(task) };
    expect(taskRetryBlocked(task)).toBe(false);
    expect(canvasGenerationRetryBlocked(metadata)).toBe(false);
    expect(canvasGenerationRetryBlocked(metadata, { prompt: "same", mode: "video" })).toBe(false);
    expect(explainGenerationError({ code: task.errorCode, message: task.error }).message).toContain("尚未提交");
    expect(canvasGenerationRetryBlocked({ ...metadata, taskStage: "submission_unknown", generationErrorCode: "submission_uncertain" })).toBe(true);
});

test("completed media with a canvas commit conflict offers reload without another paid generation", () => {
    const failure = canvasGenerationFailureMetadata({ code: "canvas_conflict" }, { prompt: "red square", mode: "video" });
    expect(failure.errorDetails).toContain("生成结果已保留");
    expect(failure.errorDetails).not.toContain("模型不接受");
    expect(failure.resourceReloadAvailable).toBe(true);
    expect(canvasGenerationRetryBlocked(failure, { prompt: "red square", mode: "video" })).toBe(true);
});

test("backend canvas revision 409 offers reload without treating it as a model failure", () => {
    const failure = canvasGenerationFailureMetadata(
        new ApiError("云端画布已有更新，已停止覆盖；请保留本地草稿并加载最新版本", { status: 409, reason: "conflict" }),
        { prompt: "red square", mode: "image" },
    );
    expect(failure.generationErrorCode).toBe("canvas_conflict");
    expect(failure.resourceReloadAvailable).toBe(true);
    expect(failure.errorDetails).toContain("生成结果已保留");
    expect(failure.errorDetails).not.toContain("模型不接受");
    expect(canvasGenerationRetryBlocked(failure, { prompt: "red square", mode: "image" })).toBe(true);
});
const task: GenerationTask = { id: "task-failure", type: "canvas_image", status: "failed", prompt: "draw", attempts: 1, createdAt: "2026-09-26T00:00:00Z", updatedAt: "2026-09-26T00:00:00Z", errorCode: "content_policy_violation", error: "opaque" };
const image = (id: string, storageKey: string): CanvasNodeData => ({ id, type: CanvasNodeType.Image, title: id, position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: `https://example.test/${id}.png`, storageKey } });

describe("canvas generation failure consumers", () => {
    test("copied diagnostics hide mounted and UNC paths and label configuration honestly", () => {
        for (const path of ["/Volumes/PrivateDrive/customer-A/image.png", "/Volumes/External Work/customer-A/image.png", String.raw`C:\Private User\customer-A\image.png`, String.raw`\\Private Server\Private Share\customer-A\image.png`, "/mnt/PrivateDrive/customer-A/image.png", String.raw`\\PrivateServer\PrivateShare\customer-A\image.png`]) {
            const copied = formatGenerationDiagnostics(explainGenerationError(new Error(`open ${path}: permission denied`)), { failureDiagnostics: { source: "local_result", summary: `open ${path}: permission denied`, input: { size: "auto", quality: "2k", count: "3", promptChars: 1, imageCount: 0, videoCount: 0, audioCount: 0 } } });
            expect(copied).not.toContain("Private");
            expect(copied).not.toContain("customer-A");
            expect(copied).toContain("任务配置（协议可能转换或省略）");
            expect(copied).not.toContain("提交参数");
        }
    });
    test("completed generation evidence survives a later canvas application failure", () => {
        const completed: GenerationTask = { ...task, status: "succeeded", failureDiagnostics: { source: "unknown", version: "1.5.9", platform: "windows/amd64", executionResult: "completed", requests: [{ operation: "image_edit", method: "POST", dispatched: true, outcome: "response_received", httpStatus: 200, requestId: "req-success-123", startedAt: "2026-09-30T15:39:23+08:00", durationMs: 48000, receivedBytes: 5672372 }], input: { size: "2048x2048", count: "1", promptChars: 20, imageCount: 3, videoCount: 0, audioCount: 0, maxImages: 2 } } };
        const metadata = canvasTaskFailureMetadata(completed, undefined, new Error("cannot apply result /Users/PRIVATE/image.png"));
        const copied = formatGenerationDiagnostics(explainGenerationError(metadata.errorDetails), { failureDiagnostics: metadata.taskFailureDiagnostics });
        expect(copied).toContain("错误来源：画布应用结果");
        expect(copied).toContain("生成执行：完成");
        expect(copied).toContain("收到响应（业务结果另判）");
        expect(copied).toContain("req-success-123");
        expect(copied).toContain("1.5.9 (windows/amd64)");
        expect(copied).toContain("尺寸=2048x2048");
        expect(copied).toContain("数量=1");
        expect(copied).toContain("5672372");
        expect(copied).not.toContain("PRIVATE");
    });
    test("task diagnostic survives canvas restore and is cleared before retry", () => {
        const diagnosticTask: GenerationTask = { ...task, errorCode: "invalid_params", failureDiagnostics: { source: "local_validation", summary: "当前图片模型最多支持 2 张参考图", stage: "校验输入" } };
        const metadata = { ...generationTaskMetadata(diagnosticTask), ...canvasTaskFailureMetadata(diagnosticTask) };
        const copied = formatGenerationDiagnostics(explainGenerationError(metadata.errorDetails), { taskId: metadata.taskId, failureDiagnostics: metadata.taskFailureDiagnostics });
        expect(copied).toContain("当前图片模型最多支持 2 张参考图");
        expect(copied).toContain("错误来源：本地参数校验");
        expect(resetGenerationTaskMetadata(metadata).taskFailureDiagnostics).toBeUndefined();
        expect(resetGenerationTaskMetadata(metadata).generationErrorSummary).toBeUndefined();
    });
    test("task cards and restored canvas retain specific moderation guidance", () => {
        for (const fixture of moderationFixtures) {
            const error = `${fixture.reason}。${fixture.action}。排查编号：请求 req_moderation_123。`;
            const failedTask = { ...task, error, errorCode: fixture.category };
            expect(taskAttentionReason(failedTask)).toContain(fixture.reason);
            expect(taskAttentionReason(failedTask)).toContain(fixture.action);
            expect(canvasTaskFailureMetadata(failedTask).errorDetails).toBe(error);
            expect(taskRetryBlocked(failedTask)).toBe(true);
        }
    });
    test("actual connected reference, rather than the source image itself, controls moderation retry", () => {
        const source = image("source", "resource:source");
        const first = image("reference-a", "resource:a");
        const second = image("reference-b", "resource:b");
        const nodes = [source, first, second];
        const context = (referenceId: string) => buildNodeGenerationContext(source.id, nodes, [{ id: "input", fromNodeId: referenceId, toNodeId: source.id }], "redraw @图片1", []);
        const submitted = context(first.id);
        const failure = canvasGenerationFailureMetadata(rejection, submitted);
        expect(submitted.referenceImages.map((reference) => reference.id)).toEqual([first.id]);
        expect(canvasGenerationRetryBlocked(failure, context(first.id))).toBe(true);
        expect(canvasGenerationRetryBlocked(failure, context(second.id))).toBe(false);
        expect(canvasGenerationRetryBlocked(failure, { ...submitted, prompt: "different drawing" })).toBe(false);
    });

    test("stable resources ignore preview URL rotation but detect content replacement", () => {
        const input = { prompt: "draw", referenceImages: [{ id: "ref", storageKey: "resource:old", url: "blob:old" }] };
        const failure = canvasGenerationFailureMetadata(rejection, input);
        expect(canvasGenerationRetryBlocked(failure, { ...input, referenceImages: [{ id: "ref", storageKey: "resource:old", url: "blob:new" }] })).toBe(true);
        expect(canvasGenerationRetryBlocked(failure, { ...input, referenceImages: [{ id: "ref", storageKey: "resource:new", url: "blob:new" }] })).toBe(false);
        const raw = { prompt: "draw", referenceImages: [{ id: "ref", dataUrl: "data:image/png;base64,a" }] };
        expect(canvasGenerationRetryBlocked(canvasGenerationFailureMetadata(rejection, raw), { ...raw, referenceImages: [{ id: "ref", dataUrl: "data:image/png;base64,b" }] })).toBe(false);
    });

    test("video, audio and masks are part of the submitted moderation input", () => {
        const input = { prompt: "draw", referenceVideos: [{ id: "video", storageKey: "resource:video" }], referenceAudios: [{ id: "audio", storageKey: "resource:audio" }], mask: { id: "mask", dataUrl: "mask-a" } };
        const failure = canvasGenerationFailureMetadata(rejection, input);
        expect(canvasGenerationRetryBlocked(failure, input)).toBe(true);
        expect(canvasGenerationRetryBlocked(failure, { ...input, referenceAudios: [] })).toBe(false);
        expect(canvasGenerationRetryBlocked(failure, { ...input, mask: { id: "mask", dataUrl: "mask-b" } })).toBe(false);
        const imageOnly = { ...input, mode: "image" as const };
        expect(canvasGenerationRetryBlocked(canvasGenerationFailureMetadata(rejection, imageOnly), { ...imageOnly, referenceAudios: [] })).toBe(true);
    });

    test("stored references survive a deleted source without pretending to be new input", async () => {
        const input = { prompt: "draw", referenceImages: [{ id: "deleted-source", url: "https://example.test/reference.png" }] };
        const failure = canvasGenerationFailureMetadata(rejection, input);
        const recovered = await resolveMetadataReferences({ generationType: "edit", references: ["https://example.test/reference.png"] });
        expect(recovered).not.toBeNull();
        expect(recovered).toHaveLength(1);
        expect(canvasGenerationRetryBlocked(failure, { prompt: "draw", referenceImages: recovered! })).toBe(true);
        expect(await resolveMetadataReferences({ generationType: "edit", references: [] })).toBeNull();
    });

    test("bulk retries and missing moderation snapshots stay blocked until reviewed", () => {
        for (const generationErrorCode of ["invalid_params", "submission_uncertain", "download_failed", "moderation_reference"]) {
            expect(canvasGenerationRetryBlocked({ generationErrorCode, errorDetails: "opaque" })).toBe(true);
        }
        expect(canvasGenerationRetryBlocked({ generationErrorCode: "moderation_reference", errorDetails: "opaque" }, { prompt: "draw", referenceImages: [{ id: "ref" }] })).toBe(true);
        expect(canvasGenerationRetryBlocked({ generationErrorCode: "throttled", errorDetails: "opaque" })).toBe(false);
        expect(canvasGenerationRetryBlocked({ generationErrorCode: "invalid_params", errorDetails: "opaque" }, { prompt: "draw" })).toBe(false);
        expect(canvasGenerationRetryBlocked({ generationErrorCode: "auth", errorDetails: "opaque" }, { prompt: "draw" })).toBe(false);
        expect(canvasGenerationRetryBlocked({ generationErrorCode: "submission_uncertain", errorDetails: "opaque" }, { prompt: "changed" })).toBe(true);
    });

    test("task recovery uses the original submitted references and structured error code", () => {
        const submitted = { prompt: "draw", referenceImages: [{ id: "ref", storageKey: "resource:old" }] };
        const failure = canvasTaskFailureMetadata({ ...task, inputJson: JSON.stringify(submitted) });
        expect(canvasGenerationRetryBlocked(failure, submitted)).toBe(true);
        expect(canvasGenerationRetryBlocked(failure, { ...submitted, referenceImages: [{ id: "ref", storageKey: "resource:new" }] })).toBe(false);
        const restored = canvasTaskFailureMetadata(task, { ...failure, taskId: task.id });
        expect(restored.failedInputFingerprint).toBe(failure.failedInputFingerprint);
    });

    test("task cards never expose raw nested JSON in the visible reason or tooltip", () => {
        const raw = { ...task, error: '{"error":{"code":"400","message":"Height must be between 300px and 6000px"}}', errorCode: "invalid_params" };
        const reason = taskAttentionReason(raw);
        expect(reason).not.toContain("{");
        expect(reason).toContain("高度");
        expect(reason).toContain("300–6000");
    });

    test("task cards preserve a machine-readable failure code alongside an opaque message", () => {
        expect(taskAttentionReason({ ...task, errorCode: "moderation_reference" })).toContain("参考素材");
        expect(taskRetryBlocked({ ...task, errorCode: "download_failed" })).toBe(true);
        expect(taskRetryBlocked({ ...task, errorCode: "invalid_params" })).toBe(true);
        expect(taskRetryBlocked({ ...task, errorCode: "throttled" })).toBe(false);
        expect(taskRetryBlocked({ ...task, errorCode: "throttled", stage: "submission_unknown" })).toBe(true);
    });
});
