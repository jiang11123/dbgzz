import { expect, test } from "bun:test";

import { canvasNodeFailureExplanation, depthCaptureWaitFailureMetadata, findDepthCaptureSourceNode, isDepthCaptureResultNode } from "@/lib/canvas/canvas-depth-capture";
import { GenerationFailureNotice } from "@/components/generation/generation-failure-notice";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type { GenerationTask } from "@/services/api/task-center";
import { generationTaskStageLabel } from "@/lib/generation-task-display";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { nodeHoverToolbarTools } from "@/lib/canvas/tool-registry/definitions/node-hover-tools";
import type { ToolContext } from "@/lib/canvas/tool-registry";
import { formatGenerationDiagnostics } from "@/lib/generation-error";

const source: CanvasNodeData = { id: "source", type: CanvasNodeType.Video, title: "原视频", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: {} };
const depth: CanvasNodeData = { id: "depth", type: CanvasNodeType.Video, title: "深度动作捕捉", position: { x: 400, y: 0 }, width: 320, height: 180, metadata: { depthSourceNodeId: source.id, taskId: "depth-task" } };

test("depth result nodes retain their dedicated retry contract instead of generic video generation", () => {
    expect(isDepthCaptureResultNode(depth)).toBe(true);
    expect(findDepthCaptureSourceNode(depth, [source, depth])).toBe(source);
    expect(isDepthCaptureResultNode(source)).toBe(false);
});

test("depth task stages show the existing CPU slow-path and CUDA fallback notice", () => {
    expect(generationTaskStageLabel({ status: "running", stage: "使用 CPU 处理，可能耗时较长" })).toBe("使用 CPU 处理，可能耗时较长");
    expect(generationTaskStageLabel({ status: "running", stage: "CUDA 设备故障，改用 CPU（可能耗时较长）" })).toBe("CUDA 设备故障，改用 CPU（可能耗时较长）");
});

test("restart-paused depth tasks ask for explicit continuation", () => {
    const paused = { ...depth, metadata: { ...depth.metadata, status: "error" as const, taskStatus: "failed", taskStage: "已暂停，等待手动继续" } };
    const explanation = canvasNodeFailureExplanation(paused);
    expect(explanation.reason).toBe("深度捕捉已暂停");
    expect(explanation.action).toContain("重试继续");
    expect(explanation.blockAutomaticRetry).toBe(false);
    const html = renderToStaticMarkup(createElement(GenerationFailureNotice, { explanation, onRetry: () => {} }));
    expect(html).toContain("重新生成");
});

test("confirmed local depth failure offers retry without relaxing paid unknown-result guards", () => {
    const failed = { ...depth, metadata: { ...depth.metadata, status: "error" as const, taskStatus: "failed", generationErrorCode: "download_failed", errorDetails: "下载生成结果失败" } };
    const explanation = canvasNodeFailureExplanation(failed);
    const html = renderToStaticMarkup(createElement(GenerationFailureNotice, { explanation, onRetry: () => {} }));
    expect(html).toContain("重新生成");
    expect(explanation.uncertain).toBe(false);
    expect(canvasNodeFailureExplanation({ ...failed, metadata: { ...failed.metadata, taskStatus: "running" } }).uncertain).toBe(true);
    expect(canvasNodeFailureExplanation({ ...failed, metadata: { ...failed.metadata, depthSourceNodeId: undefined } }).uncertain).toBe(true);
});

test("observation failure keeps a known active depth task loading", () => {
    const task = { id: "depth-task", status: "running" } as GenerationTask;
    const metadata = depthCaptureWaitFailureMetadata(new Error("任务执行超时，请稍后重试"), task);
    expect(metadata.status).toBe("loading");
    expect(metadata.errorDetails).toBeUndefined();
    expect(metadata.taskClientOperationTerminal).toBeUndefined();
    expect(depthCaptureWaitFailureMetadata(new Error("HTTP 503"), "depth-task").status).toBe("loading");
    expect(depthCaptureWaitFailureMetadata(new Error("invalid input")).status).toBe("error");
});

test("hover retry preserves cloud download guards and recovers completed local output", () => {
    const retry = nodeHoverToolbarTools.find(tool => tool.id === "retry")!;
    const makeContext = (node: CanvasNodeData) => ({ node, nodeMetadata: node.metadata }) as ToolContext;
    const cloud = { ...source, metadata: { status: "error" as const, taskStatus: "failed", generationErrorCode: "download_failed", errorDetails: "download_failed" } };
    expect(retry.applicable?.(makeContext(cloud))).toBe(false);
    const failedDepth = { ...depth, metadata: { ...cloud.metadata, ...depth.metadata } };
    expect(retry.applicable?.(makeContext(failedDepth))).toBe(true);
    const completedDepth = { ...failedDepth, metadata: { ...failedDepth.metadata, taskStatus: "succeeded" } };
    expect(retry.applicable?.(makeContext(completedDepth))).toBe(true);
    expect(typeof retry.displayLabel === "function" ? retry.displayLabel(makeContext(completedDepth)) : retry.displayLabel).toBe("恢复结果");
    const explanation = canvasNodeFailureExplanation(completedDepth);
    const html = renderToStaticMarkup(createElement(GenerationFailureNotice, { explanation, onRetry: () => {}, retryLabel: "恢复结果" }));
    expect(html).toContain("恢复结果");
    expect(html).not.toContain("重新生成");
});

test("copied local failure diagnostics retain the exit cause within the safe summary budget", () => {
    const message = "\r 0 0 0 0 Time Time Current".repeat(150) + "\ncurl: (28) Connection timed out\n模型补下载失败";
    const summary = "… 0 0 0 0 Time Time Current ".repeat(7) + "\ncurl: (28) Connection timed out\n模型补下载失败";
    const failed = { ...depth, metadata: { ...depth.metadata, status: "error" as const, taskStatus: "failed", errorDetails: message } };
    const diagnostics = formatGenerationDiagnostics(canvasNodeFailureExplanation(failed), {taskId: "depth-task", failureDiagnostics: {source: "local_result", summary, stage: "深度处理失败", requestId: "req-depth-local"}});
    expect(diagnostics).toContain("curl: (28) Connection timed out");
    expect(diagnostics).toContain("模型补下载失败");
    expect(diagnostics).toContain("错误来源：本地结果处理");
    expect(diagnostics).toContain("请求 ID：req-depth-local");
});
