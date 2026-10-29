import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { GenerationFailureNotice } from "../src/components/generation/generation-failure-notice";
import { explainGenerationError, shouldBlockAutomaticRetry, shouldBlockManualRetry } from "../src/lib/generation-error";
import { CreationMessageView } from "../src/pages/create/creation-workspace";
import { taskRetryBlocked } from "../src/pages/tasks/task-shared";
import { canvasGenerationRetryBlocked } from "../src/pages/canvas/canvas-generation-failure";
import { selectRetryableImageBatchChildren } from "../src/pages/canvas/canvas-generation-orchestration";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";
import type { GenerationTask } from "../src/services/api/task-center";

const preparationMessages = [
    ["image_reference_upload_failed", "参考图片上传失败，本次尚未开始生成。请稍后重试。"],
    ["reference_media_upload_failed", "参考素材上传失败，本次尚未开始生成。请检查对象存储配置和公开读取权限后重试。"],
] as const;

function task(error: string, stage = "准备参考素材"): GenerationTask {
    return { id: "task-reference", type: "canvas_image", status: "failed", errorCode: "provider_unavailable", error, stage, attempts: 1, createdAt: "2026-10-17T10:00:00Z", updatedAt: "2026-10-17T10:00:01Z" };
}

function creation(error: string, generationStage?: string) {
    return renderToStaticMarkup(<CreationMessageView
        item={{ id: "message-reference", role: "assistant", mode: "image", content: "", status: "error", error, generationStage, createdAt: "2026-10-17T10:00:00Z" }}
        shotNumber={1} onRetryFailure={() => {}} onCreateVariant={() => {}} onEditUserMessage={() => {}} onContinueCanvas={() => {}} openingCanvas={false}
    />);
}

test("local runtime preserves confirmed preparation copy and offers only manual retry", () => {
    for (const [code, message] of preparationMessages) {
        const explanation = explainGenerationError(message);
        expect(explanation.providerCode).toBe(code);
        expect(explanation.category).toBe("provider_unavailable");
        expect(explanation.message).toBe(message);
        expect(explanation.retryable).toBe(false);
        expect(explanation.uncertain).toBe(false);
        expect(shouldBlockAutomaticRetry(message)).toBe(true);
        expect(shouldBlockManualRetry(message)).toBe(false);
        expect(taskRetryBlocked(task(message))).toBe(false);
        const notice = renderToStaticMarkup(<GenerationFailureNotice explanation={explanation} onRetry={() => {}} />);
        expect(notice).toContain("重新生成");
        const html = creation(message);
        expect(html).toContain("本次尚未开始生成");
        expect(html).toContain("重新生成");
        expect(html).not.toContain("本地资源目录");
        if (code === "image_reference_upload_failed") expect(html).not.toContain("检查对象存储");
    }
});

test("unknown stage overrides later preparation text in creation and task center", () => {
    for (const [, message] of preparationMessages) {
        expect(shouldBlockManualRetry(message, "submission_unknown")).toBe(true);
        expect(taskRetryBlocked(task(message, "submission_unknown"))).toBe(true);
        const html = creation(message, "submission_unknown");
        expect(html).toContain("提交结果尚未确认");
        expect(html).not.toContain("本次尚未开始生成");
        expect(html).not.toContain("重新生成");
    }
});

test("untrusted HTTP echoes and upload short messages do not grant manual retry", () => {
    for (const [code, message] of preparationMessages) {
        for (const status of [400, 403, 503]) {
            for (const data of [message, { error: { code, message } }]) {
                const error = { status, data };
                expect(explainGenerationError(error).uncertain).toBe(true);
                expect(shouldBlockManualRetry(error)).toBe(true);
            }
        }
        expect(shouldBlockManualRetry({ code, message: "参考图片上传失败" })).toBe(true);
    }
    expect(shouldBlockManualRetry("参考图片上传失败")).toBe(true);
    expect(creation("参考图片上传失败")).not.toContain("重新生成");
});

test("manual canvas and batch retry keep preparation distinct from unknown submission", () => {
    for (const [, message] of preparationMessages) {
        const node: CanvasNodeData = { id: "prepared", type: CanvasNodeType.Image, title: "镜头", width: 320, height: 180, position: { x: 0, y: 0 }, metadata: { status: "error", generationErrorCode: "provider_unavailable", errorDetails: message } };
        const unknown = { ...node, id: "unknown", metadata: { ...node.metadata, taskStage: "submission_unknown" } };
        expect(canvasGenerationRetryBlocked(node.metadata)).toBe(false);
        expect(canvasGenerationRetryBlocked(unknown.metadata)).toBe(true);
        expect(selectRetryableImageBatchChildren([node, unknown])).toEqual({ retryable: [node], blocked: true });
    }
});
