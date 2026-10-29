import { expect, mock, test } from "bun:test";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { canvasThemes } from "@/lib/canvas-theme";
import type { GenerationTaskDeliveryProgress } from "@/services/api/task-center";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { OperationProgress } from "@/lib/operation-progress";

// Server rendering only sees zustand's initial snapshot, so the progress store
// is replaced with a plain selector over a test-owned map.
const byTask: Record<string, GenerationTaskDeliveryProgress> = {};
mock.module("@/stores/use-generation-delivery-progress", () => ({
    useGenerationDeliveryProgress: <T,>(selector: (state: { byTask: typeof byTask }) => T) => selector({ byTask }),
    publishGenerationDeliveryProgress: () => {},
}));
const { CanvasNodeContent } = await import("@/components/canvas/canvas-node-content");
const { CanvasNodeGenerationProgress } = await import("@/components/canvas/canvas-node-generation-progress");

function render(node: CanvasNodeData) {
    return renderToStaticMarkup(<CanvasNodeContent node={node} theme={canvasThemes.dark} isEditingContent={false} textareaRef={createRef<HTMLTextAreaElement>()} isBatchRoot={false} batchCount={0} batchExpanded={false} batchOpening={false} batchRecovering={false} onContentChange={() => {}} onStopEditing={() => {}} onCancelTask={() => {}} mentionReferences={[]} />);
}

const loadingVideo: CanvasNodeData = { id: "video-1", type: CanvasNodeType.Video, title: "镜头", position: { x: 0, y: 0 }, width: 320, height: 220, metadata: { status: "loading", taskId: "task-1", taskStatus: "succeeded" } };

test("取回结果时节点显示进度、大小和速度，而不是「生成中」", () => {
    byTask["task-1"] = { outputIndex: 0, downloadedBytes: 12_900_000, totalBytes: 41_943_040, bytesPerSecond: 1_258_291, state: "downloading", updatedAt: Date.now() };
    const markup = render(loadingVideo);
    delete byTask["task-1"];
    expect(markup).toContain("正在取回结果");
    expect(markup).toContain("30%");
    expect(markup).toContain("12 MB / 40 MB");
    expect(markup).toContain("1.2 MB/s");
    expect(markup).toContain("预计剩余 24 秒");
    expect(markup).not.toContain("生成中");
});

test("下载中断时显示正在重试", () => {
    byTask["task-1"] = { outputIndex: 0, downloadedBytes: 2_000_000, totalBytes: 4_000_000, bytesPerSecond: 0, state: "retrying" };
    const markup = render(loadingVideo);
    delete byTask["task-1"];
    expect(markup).toContain("下载中断，正在重试");
    expect(markup).toContain("50%");
});

test("任务已成功但还没有进度时显示正在取回结果", () => {
    const markup = render(loadingVideo);
    expect(markup).toContain("正在取回结果");
    expect(markup).not.toContain("生成中");
    expect(markup).toContain("停止取回结果");
    expect(markup).not.toContain("取消生成任务");
});

test("结果已保留的失败节点提供「继续取回」", () => {
    const markup = render({ ...loadingVideo, metadata: { status: "error", taskId: "task-1", taskStatus: "succeeded", generationErrorCode: "download_failed", resourceReloadAvailable: true } });
    expect(markup).toContain("继续取回");
    expect(markup).not.toContain("重新加载资源");
});

test("正在取回生成结果阶段即使还没有字节也显示取回中，不显示已用时间", () => {
    const fetchingNode: CanvasNodeData = { ...loadingVideo, metadata: { status: "loading", taskId: "task-1", taskStatus: "running", taskStage: "正在取回生成结果" } };
    const markup = render(fetchingNode);
    expect(markup).toContain("正在取回结果");
    expect(markup).not.toContain("已用");
    expect(markup).not.toContain("生成中");
});

test("任务创建前在节点内上传参考素材，不暴露旧任务的取消操作", () => {
    const operation: OperationProgress = { id: "upload", title: "上传参考素材", detail: "正在上传参考视频 1", phase: "transferring", target: { projectId: "canvas-a", nodeId: loadingVideo.id }, loadedBytes: 2 * 1024 ** 2, totalBytes: 8 * 1024 ** 2, bytesPerSecond: 1024 ** 2, startedAt: Date.now() - 2000, updatedAt: Date.now() };
    const markup = renderToStaticMarkup(<CanvasNodeGenerationProgress node={loadingVideo} theme={canvasThemes.dark} operation={operation} onCancelTask={() => {}} />);
    expect(markup).toContain("正在上传参考视频 1");
    expect(markup).toContain("25%");
    expect(markup).toContain("2.0 MB / 8.0 MB");
    expect(markup).toContain("1.0 MB/s");
    expect(markup).toContain("预计剩余 6 秒");
    expect(markup).not.toContain("取消生成任务");
    expect(markup).not.toContain("停止取回结果");
});

test("保存结果时节点保持等待，不把传输完成显示成已可用", () => {
    const operation: OperationProgress = { id: "save", title: "保存生成结果", detail: "正在保存视频并更新画布", phase: "processing", target: { projectId: "canvas-a", nodeId: loadingVideo.id, taskId: "task-1" }, loadedBytes: 1024, totalBytes: 1024, startedAt: Date.now() - 2000, updatedAt: Date.now() };
    const markup = renderToStaticMarkup(<CanvasNodeGenerationProgress node={{ ...loadingVideo, metadata: { ...loadingVideo.metadata, status: "success" } }} theme={canvasThemes.dark} operation={operation} onCancelTask={() => {}} />);
    expect(markup).toContain("正在保存视频并更新画布");
    expect(markup).toContain('role="progressbar"');
    expect(markup).not.toContain("100%");
    expect(markup).not.toContain("停止取回结果");
});
