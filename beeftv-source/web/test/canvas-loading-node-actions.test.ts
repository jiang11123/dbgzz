import { describe, expect, test } from "bun:test";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasNodeContent } from "@/components/canvas/canvas-node-content";
import { canvasThemes } from "@/lib/canvas-theme";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

describe("canvas loading node actions", () => {
    test.each(["queued", "running", "succeeded", "failed"] as const)("%s offers the appropriate generation or delivery action", (taskStatus) => {
        const node: CanvasNodeData = {
            id: "video-1", type: CanvasNodeType.Video, title: "镜头", position: { x: 0, y: 0 }, width: 320, height: 220,
            metadata: { status: "loading", taskId: "task-1", taskStatus },
        };
        const content = renderToStaticMarkup(createElement(CanvasNodeContent, {
            node, theme: canvasThemes.dark, isEditingContent: false, textareaRef: createRef<HTMLTextAreaElement>(),
            isBatchRoot: false, batchCount: 0, batchExpanded: false, batchOpening: false, batchRecovering: false,
            onContentChange: () => {}, onStopEditing: () => {}, onCancelTask: () => {}, mentionReferences: [],
        }));
        expect(content.includes('aria-label="取消生成任务"')).toBe(taskStatus === "queued" || taskStatus === "running");
        expect(content.includes('aria-label="停止取回结果"')).toBe(taskStatus === "succeeded");
    });
});
