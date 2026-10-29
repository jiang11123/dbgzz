import { describe, expect, test } from "bun:test";

import { explainGenerationError, shouldBlockAutomaticRetry } from "@/lib/generation-error";
import { CanvasGenerationDurableAckError, CanvasGenerationMaterializationError } from "@/services/canvas-generation-errors";
import { ApiError } from "@/services/api/request";
import { canvasGenerationFailureMetadata, canvasGenerationRetryBlocked, canvasImageGenerationHasPendingResult, canvasGenerationTaskNodes, isKeptGenerationResultCode } from "@/pages/canvas/canvas-generation-failure";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { GenerationTask } from "@/services/api/task-center";
import { assistantProposalProgress } from "@/pages/canvas/canvas-assistant-copy";
import { applyGeneratedMediaResultMetadata, videoMetadata } from "@/lib/canvas/canvas-generation-task-sync";

function node(metadata: CanvasNodeData["metadata"]): CanvasNodeData {
    return { id: "n1", type: CanvasNodeType.Image, title: "镜头", position: { x: 0, y: 0 }, width: 100, height: 100, metadata };
}

const succeededTask: GenerationTask = {
    id: "task-1",
    type: "canvas_image",
    status: "succeeded",
    prompt: "猫",
    attempts: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("generation result-apply error codes", () => {
    test("a retained video is not a newly succeeded task output until its own binding arrives", () => {
        const proposal = { proposalId: "new", kind: "video" as const, nodeIds: ["n1"], model: "fixture", modelKey: "fixture" };
        const original = { ...node({ taskId: "new-task", taskClientOperationId: "proposal:new:n1", status: "loading", content: "old-video.mp4", storageKey: "resource:old", assetId: "old-asset", generationEffectKeys: ["attach-node:old-task:n1:0"] }), type: CanvasNodeType.Video };
        const completed: GenerationTask = { ...succeededTask, id: "new-task", type: "canvas_video", clientOperationId: "proposal:new:n1", outputs: [{ outputIndex: 0, mediaType: "video", materializedAssetId: "new-asset" }] };
        for (const task of [completed, { ...completed, outputs: undefined }]) {
            const [pending] = canvasGenerationTaskNodes([original], "n1", task);
            expect(pending.metadata).toMatchObject({ status: "loading", content: "old-video.mp4", storageKey: "resource:old", assetId: "old-asset" });
            expect(assistantProposalProgress(proposal, [pending]).ready).toBe(false);
        }
        const delivered = { ...original, metadata: applyGeneratedMediaResultMetadata(original, videoMetadata({ url: "new-video.mp4", storageKey: "resource:new", mimeType: "video/mp4", bytes: 100 }), { assetId: "new-asset", generationEffectKeys: ["attach-node:new-task:n1:0"] }) };
        // The canonical binding owns the new asset, after the media helper has cleared the old one.
        delivered.metadata.assetId = "new-asset";
        const [ready] = canvasGenerationTaskNodes([delivered], "n1", completed);
        expect(ready.metadata).toMatchObject({ status: "success", content: "new-video.mp4", storageKey: "resource:new", assetId: "new-asset" });
        expect(assistantProposalProgress(proposal, [ready]).ready).toBe(true);
    });
    test("paused delivery keeps a recovery action even when the node retains old media", () => {
        for (const stage of ["delivery_paused", "delivery_timed_out"]) {
            for (const content of [undefined, "old-video.mp4"]) {
                const original = node({ taskId: "task-1", status: "loading", content });
                const [next] = canvasGenerationTaskNodes([original], "n1", { ...succeededTask, stage, outputs: [{ outputIndex: 0, mediaType: "video", materializationErrorCode: stage }] });
                expect(next.metadata?.status).toBe("error");
                expect(next.metadata?.resourceReloadAvailable).toBe(true);
                expect(next.metadata?.generationErrorCode).toBe("download_failed");
                expect(next.metadata?.content).toBe(content);
            }
        }
    });

    test("old media is not the pending task output and completed outputs still win over pause", () => {
        const original = node({ taskId: "task-1", status: "loading", content: "old-video.mp4" });
        const pending = { ...succeededTask, outputs: [{ outputIndex: 0, mediaType: "video" as const }] };
        expect(canvasGenerationTaskNodes([original], "n1", pending)[0].metadata?.status).toBe("loading");
        const complete = { ...pending, stage: "delivery_paused", outputs: [{ outputIndex: 0, mediaType: "video" as const, materializedAssetId: "asset-current" }] };
        const [next] = canvasGenerationTaskNodes([original], "n1", complete);
        expect(next.metadata?.status).toBe("success");
        expect(next.metadata?.resourceReloadAvailable).toBeUndefined();
        expect(canvasGenerationTaskNodes([original], "n1", succeededTask)[0].metadata?.status).toBe("success");
    });
    test("durable ack is a canvas conflict only for a revision conflict", () => {
        const conflict = new CanvasGenerationDurableAckError(new ApiError("云端画布已有更新", { status: 409, reason: "stale_revision" }));
        expect(conflict.code).toBe("canvas_conflict");
        expect(conflict.message).toContain("画布尚未更新");

        const applyFailed = new CanvasGenerationDurableAckError(new Error("bind refused"));
        expect(applyFailed.code).toBe("result_apply_failed");
        expect(applyFailed.message).toContain("还没放回画布");
        expect(explainGenerationError(applyFailed).category).toBe("result_apply_failed");
        expect(shouldBlockAutomaticRetry(applyFailed)).toBe(true);
    });

    test("materialization failure is a download failure, not a canvas conflict", () => {
        const error = new CanvasGenerationMaterializationError(new Error("connection reset"));
        expect(error.code).toBe("download_failed");
        expect(error.message).toContain("还没取回");
        expect(explainGenerationError(error).category).toBe("download_failed");
        expect(shouldBlockAutomaticRetry(error)).toBe(true);
        expect(shouldBlockAutomaticRetry({ code: "download_failed" })).toBe(true);
    });

    test("kept-result codes include both reloadable results and saved history recovery", () => {
        for (const code of ["canvas_conflict", "download_failed", "result_apply_failed", "result_target_unavailable"]) {
            expect(isKeptGenerationResultCode(code)).toBe(true);
        }
        for (const code of [undefined, "", "throttled", "auth"]) {
            expect(isKeptGenerationResultCode(code)).toBe(false);
        }
    });

    test("failure metadata offers resource reload for reloadable kept-result codes", () => {
        for (const code of ["canvas_conflict", "download_failed", "result_apply_failed"]) {
            const failure = canvasGenerationFailureMetadata({ code }, { prompt: "猫", mode: "image" });
            expect(failure.generationErrorCode).toBe(code);
            expect(failure.resourceReloadAvailable).toBe(true);
            expect(canvasGenerationRetryBlocked(failure, { prompt: "猫", mode: "image" })).toBe(true);
        }
    });

    test("pending-result detection and task nodes keep the retained code", () => {
        for (const code of ["canvas_conflict", "download_failed", "result_apply_failed"]) {
            const pending = node({ taskId: "task-1", status: "error", generationErrorCode: code, resourceReloadAvailable: true });
            expect(canvasImageGenerationHasPendingResult(pending, [pending])).toBe(true);
            const [next] = canvasGenerationTaskNodes([pending], "n1", succeededTask);
            expect(next.metadata?.generationErrorCode).toBe(code);
            expect(next.metadata?.status).toBe("error");
            expect(next.metadata?.resourceReloadAvailable).toBe(true);
        }
    });
});
