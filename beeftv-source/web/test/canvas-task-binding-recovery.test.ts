import { expect, test } from "bun:test";

import { canvasNodeFailureExplanation, depthCaptureWaitFailureMetadata, isDepthCaptureResultNode } from "@/lib/canvas/canvas-depth-capture";
import { clearInPlaceMediaOutputMetadata, generationTaskMetadata } from "@/lib/canvas/canvas-project-generation";
import { explainGenerationError } from "@/lib/generation-error";
import type { GenerationTask } from "@/services/api/task-center";
import { ApiError } from "@/services/api/request";
import { isCanvasRevisionConflict } from "@/services/canvas-revision-conflict";
import { CanvasGenerationDurableAckError } from "@/services/canvas-generation-errors";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const node: CanvasNodeData = {
    id: "depth-node", type: CanvasNodeType.Video, title: "深度动作捕捉",
    position: { x: 0, y: 0 }, width: 320, height: 180,
    metadata: { depthSourceNodeId: "source-video", taskId: "depth-task", taskStatus: "succeeded" },
};
const task = { id: "paid-video", type: "canvas_video", status: "succeeded", provider: "newapi", model: "seedance-2.0-mini" } as GenerationTask;
const conflict = new ApiError("节点已绑定到其他任务，未覆盖该节点", {
    status: 409, reason: "node_task_mismatch", requestId: "req-bind-conflict",
});

test("paid regeneration removes the local depth executor identity", () => {
    const metadata = clearInPlaceMediaOutputMetadata(node.metadata);
    expect(metadata.depthSourceNodeId).toBeUndefined();
    expect(metadata.taskId).toBeUndefined();
});

test("a cloud task on a legacy depth node uses cloud recovery and copy", () => {
    const updated = { ...node, metadata: { ...node.metadata, ...generationTaskMetadata(task), status: "error" as const, generationErrorCode: "result_apply_failed" } };
    expect(isDepthCaptureResultNode(updated)).toBe(false);
    expect(canvasNodeFailureExplanation(updated).reason).not.toContain("深度视频");
});

test("canvas binding conflicts are local result failures, not model parameter rejection", () => {
    const explanation = explainGenerationError(conflict);
    expect(explanation.category).toBe("result_target_unavailable");
    expect(explanation.httpStatus).toBe(409);
    expect(explanation.requestId).toBe("req-bind-conflict");
    expect(explanation.message).not.toContain("参数");
});

test("a task identity conflict is not treated as an outdated canvas revision", () => {
    expect(isCanvasRevisionConflict(conflict)).toBe(false);
    expect(new CanvasGenerationDurableAckError(conflict).code).toBe("result_target_unavailable");
    expect(isCanvasRevisionConflict(new ApiError("画布已有更新", { status: 409, reason: "stale_revision" }))).toBe(true);
});

test("failed recovery of a succeeded depth task retains the local bind diagnosis", () => {
    const depthTask = { ...task, id: "depth-task", type: "depth_capture" } as GenerationTask;
    const metadata = depthCaptureWaitFailureMetadata(conflict, depthTask);
    expect(metadata).toMatchObject({ status: "error", generationErrorCode: "result_target_unavailable", taskStage: "画布应用结果" });
    expect(metadata.taskFailureDiagnostics).toMatchObject({ source: "client_result", executionResult: "completed", stage: "画布应用结果", summary: conflict.message, requestId: conflict.requestId });
    expect(metadata.errorDetails).not.toContain("模型不接受");
});
