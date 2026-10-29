import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import contract from "../../fixtures/vod-image-errors.json";
import { explainGenerationError } from "../src/lib/generation-error";
import { GenerationFailureNotice } from "../src/components/generation/generation-failure-notice";
import { canvasGenerationFailureMetadata } from "../src/pages/canvas/canvas-generation-failure";
import { canvasNodeFailureExplanation } from "../src/lib/canvas/canvas-depth-capture";
import { taskAttentionReason, taskRetryBlocked } from "../src/pages/tasks/task-shared";
import { CanvasNodeType } from "../src/types/canvas";
import type { GenerationTask } from "../src/services/api/task-center";

for (const [stage, codes] of Object.entries(contract.cases)) {
    for (const [code, key] of Object.entries(codes)) {
        test(`VOD ${stage}/${code} has actionable canvas copy`, () => {
            const expected = contract.copies[key as keyof typeof contract.copies];
            const text = stage === "task" ? `VOD image task failed [${code}]: opaque` : `VOD ${code}: opaque`;
            for (const error of [text, { error: { code: "bad_response", message: text } }]) {
                const result = explainGenerationError(error);
                expect(result.category).toBe(expected.category);
                expect(result.reason).toBe(expected.reason);
                expect(result.action).toBe(expected.action);
                expect(Boolean(result.uncertain)).toBe(expected.uncertain);
                const metadata = canvasGenerationFailureMetadata(error, { prompt: "draw", mode: "image" });
                const restored = explainGenerationError({ code: metadata.generationErrorCode, message: metadata.errorDetails });
                expect(restored.reason).toBe(expected.reason);
                expect(restored.action).toBe(expected.action);
            }
        });
    }
}

for (const [key, copy] of Object.entries(contract.copies)) {
    test(`VOD gateway ${key} survives persistence and renders safe actions`, () => {
        const code = key === "moderation" ? "content_policy_violation" : `vod_image_${key}`;
        const message = `${copy.reason}。${copy.action}。`;
        const error = { error: { code, message }, request_id: "req-vod-123", task_id: "task-vod-123" };
        const result = explainGenerationError(error);
        expect(result.category).toBe(copy.category);
        expect(result.reason).toBe(copy.reason);
        expect(result.action).toBe(copy.action);
        expect(Boolean(result.uncertain)).toBe(copy.uncertain);
        const restored = explainGenerationError({ code: result.category, message: result.message });
        expect(restored.reason).toBe(copy.reason);
        expect(restored.action).toBe(copy.action);
        const html = renderToStaticMarkup(<GenerationFailureNotice compact explanation={result} onRetry={() => {}} onOpenDetails={() => {}} />);
        expect(html).toContain(copy.reason);
        expect(html).toContain(copy.action);
        if (copy.uncertain) {
            expect(result.blockAutomaticRetry).toBe(true);
            expect(html).toContain("查看原任务");
            expect(html).not.toContain(">重新生成<");
            const gatewayUnknown = explainGenerationError({ code: "image_result_unknown", message });
            expect(gatewayUnknown.reason).toBe(copy.reason);
            const metadata = { ...canvasGenerationFailureMetadata(error, { prompt: "draw", mode: "image" }), taskStage: "submission_unknown", taskId: "task-vod-123" };
            const node = { id: "image-vod-123", type: CanvasNodeType.Image, title: "图片", position: { x: 0, y: 0 }, width: 260, height: 260, metadata };
            const nodeResult = canvasNodeFailureExplanation(node);
            expect(nodeResult.reason).toBe(copy.reason);
            expect(nodeResult.blockAutomaticRetry).toBe(true);
            const task: GenerationTask = { id: "task-vod-123", type: "canvas_image", status: "failed", stage: "submission_unknown", prompt: "draw", attempts: 1, createdAt: "2026-10-17T00:00:00Z", updatedAt: "2026-10-17T00:00:00Z", errorCode: result.category, error: result.message };
            expect(taskAttentionReason(task)).toContain(copy.reason);
            expect(taskRetryBlocked(task)).toBe(true);
        }
        expect(html).not.toContain("opaque");
    });
}

test("VOD copy cannot override authoritative errors or request echoes", () => {
    for (const message of ["VOD image task failed [TaskTimeout]: opaque", "图片任务执行超时。请联系支持查询原任务结果，不要立即重新生成。"] ) {
        expect(explainGenerationError({ code: "invalid_api_key", message }).category).toBe("auth");
        expect(explainGenerationError({ prompt: message }).category).toBe("unknown");
    }
    expect(explainGenerationError("VOD FutureCode: opaque").category).toBe("submission_uncertain");
    expect(explainGenerationError("VOD image task failed [FutureCode]: opaque").category).toBe("async_failed");
    expect(explainGenerationError("VOD constructor: opaque").category).toBe("submission_uncertain");
    expect(explainGenerationError({ code: "vod_image_toString", message: "opaque" }).category).toBe("unknown");
    expect(explainGenerationError({ code: "access_denied", message: "你的请求触发了上游内容安全策略，类别：内容安全。本次请求已被上游拒绝。" }).moderation).toBe(true);
    expect(explainGenerationError("VOD image task failed [ModelGenerateFailed]: Your request was rejected by the safety system.").moderation).toBe(true);
});

test("VOD generic wrappers follow the same stage and authority contract as Go", () => {
    const wrappers = ["", "unknown", "failed", "badrequest", "api_error", "upstream_error", "upstream_rejected", "invalid_request", "invalid_request_error", "invalid_parameter", "invalidparameter", "invalid_argument", "bad_response", "bad_response_body", "400", "401", "403", "500", "502", "503"];
    for (const [stage, codes] of Object.entries(contract.cases)) for (const [code, key] of Object.entries(codes)) {
        const text = stage === "task" ? `VOD image task failed [${code}]: opaque` : `VOD ${code}: opaque`;
        const expected = contract.copies[key as keyof typeof contract.copies];
        for (const wrapper of wrappers) {
            const result = explainGenerationError({ error: { code: wrapper, message: text } });
            expect(result.reason).toBe(expected.reason);
            expect(result.category).toBe(expected.category);
        }
    }
});
