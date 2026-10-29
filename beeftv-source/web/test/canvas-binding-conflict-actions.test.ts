import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { GenerationFailureNotice } from "@/components/generation/generation-failure-notice";
import { canvasNodeFailureExplanation } from "@/lib/canvas/canvas-depth-capture";
import { nodeHoverToolbarTools } from "@/lib/canvas/tool-registry/definitions/node-hover-tools";
import type { ToolContext } from "@/lib/canvas/tool-registry";
import { canvasGenerationFailureMetadata, canvasGenerationRetryBlocked, canvasGenerationTaskNodes, canvasImageGenerationHasPendingResult, canvasImagePendingResultMessage } from "@/pages/canvas/canvas-generation-failure";
import type { GenerationTask } from "@/services/api/task-center";
import { canvasNodeRetryPlan } from "@/pages/canvas/canvas-generation-orchestration";
import { ApiError } from "@/services/api/request";
import { CanvasGenerationDurableAckError } from "@/services/canvas-generation-errors";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

test("a genuinely replaced target opens generation history instead of repeating a rejected bind", () => {
    const error = new CanvasGenerationDurableAckError(new ApiError("节点已绑定到其他任务，未覆盖该节点", { status: 409, reason: "node_task_mismatch" }));
    const failure = canvasGenerationFailureMetadata(error, { prompt: "synthetic" });
    expect(failure.generationErrorCode).toBe("result_target_unavailable");
    expect(failure.resourceReloadAvailable).toBe(false);
    const node: CanvasNodeData = { id: "target", title: "视频", type: CanvasNodeType.Video,
        width: 320, height: 180, position: { x: 0, y: 0 },
        metadata: { taskId: "original-task", taskStatus: "succeeded", status: "error", ...failure } };
    expect(canvasNodeRetryPlan(node, [])).toEqual({ kind: "history" });
    const explanation = canvasNodeFailureExplanation(node);
    expect(explanation.reason).not.toContain("参数");
    expect(explanation.action).toContain("生成历史");
    const html = renderToStaticMarkup(createElement(GenerationFailureNotice, { explanation, onRetry: () => {}, retryLabel: "生成历史" }));
    expect(html).toContain("生成历史");
    expect(html).not.toContain("重新生成</button>");
    const retry = nodeHoverToolbarTools.find(item => item.id === "retry")!;
    const context = { node, nodeMetadata: node.metadata } as ToolContext;
    expect(typeof retry.displayLabel === "function" ? retry.displayLabel(context) : retry.displayLabel).toBe("生成历史");
});

test("image pending-result messages and later task sync keep the saved-history action", () => {
    const node: CanvasNodeData = { id: "image", title: "图片", type: CanvasNodeType.Image, position: { x: 0, y: 0 }, width: 320, height: 180,
        metadata: { taskId: "saved-task", generationErrorCode: "result_target_unavailable", resourceReloadAvailable: false } };
    expect(canvasImageGenerationHasPendingResult(node, [])).toBe(true);
    expect(canvasGenerationRetryBlocked(node.metadata, { prompt: "synthetic" })).toBe(true);
    expect(canvasImagePendingResultMessage(node, [])).toContain("生成历史");
    expect(canvasImagePendingResultMessage(node, [])).not.toContain("继续取回");
    const root = { ...node, id: "root", metadata: { batchChildIds: [node.id] } };
    expect(canvasImagePendingResultMessage(root, [node])).toContain("生成历史");
    const [synced] = canvasGenerationTaskNodes([node], node.id, { id: "saved-task", type: "canvas_image", status: "succeeded" } as GenerationTask);
    expect(synced.metadata?.generationErrorCode).toBe("result_target_unavailable");
    expect(synced.metadata?.resourceReloadAvailable).toBe(false);
    expect(synced.metadata?.errorDetails).toContain("生成历史");
    expect(canvasNodeRetryPlan(synced, [])).toEqual({ kind: "history" });
});
