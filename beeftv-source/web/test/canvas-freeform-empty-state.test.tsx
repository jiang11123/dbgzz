import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { CanvasFreeformEmptyState } from "@/components/canvas/canvas-short-drama-entry";
import type { CanvasCreateCommand } from "@/components/canvas/canvas-create-menu";
import { CanvasNodeContent } from "@/components/canvas/canvas-node-content";
import { canvasThemes } from "@/lib/canvas-theme";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { resolveAddNodeMenuCommands, type AddNodeMenuContext } from "@/lib/canvas/tool-registry";
import { createRef } from "react";

const commands: CanvasCreateCommand[] = [
    { id: "script", label: "脚本", icon: null, section: "node", onClick: () => {} },
    { id: "image", label: "图片", icon: null, section: "node", onClick: () => {} },
    { id: "video", label: "视频", icon: null, section: "node", onClick: () => {} },
    { id: "audio", label: "音频", icon: null, section: "node", onClick: () => {} },
];

describe("BeefTV freeform canvas empty state", () => {
    test("exposes the double-click hint without obsolete quick starts", () => {
        const markup = renderToStaticMarkup(<CanvasFreeformEmptyState commands={commands} />);
        expect(markup).toContain("双击画布");
        expect(markup).toContain("自由生成节点");
        expect(markup).toContain("点击可显示/隐藏画布上的连线");
        expect(markup).toContain('aria-label="关闭连线提示"');
        for (const label of ["故事脚本生成", "角色三视图", "全能参考生视频", "音频生视频"]) expect(markup).not.toContain(label);
        expect(markup).toContain('aria-label="添加第一项"');
        // 空状态只是视觉引导，不能把中心空白区域标成 no-zoom，否则会吞掉
        // InfiniteCanvas 用来打开 LibTV 添加节点面板的双击事件。
        expect(markup).not.toContain("data-canvas-no-zoom");
    });

    test("does not reintroduce quick starts when an optional command is unavailable", () => {
        const markup = renderToStaticMarkup(<CanvasFreeformEmptyState commands={commands.filter((command) => command.id !== "audio")} />);
        expect(markup).not.toContain("故事脚本生成");
        expect(markup).not.toContain("音频生视频");
    });

    test("renders the minimal empty text node state", () => {
        const node: CanvasNodeData = { id: "text-1", type: CanvasNodeType.Text, title: "文本节点 1", position: { x: 0, y: 0 }, width: 350, height: 350, metadata: { content: "", status: "idle" } };
        const markup = renderToStaticMarkup(<CanvasNodeContent node={node} theme={canvasThemes.dark} isEditingContent={false} textareaRef={createRef<HTMLTextAreaElement>()} isBatchRoot={false} batchCount={0} batchExpanded={false} batchOpening={false} batchRecovering={false} onContentChange={() => {}} onStopEditing={() => {}} mentionReferences={[]} />);
        for (const label of ["自己编写内容", "文生视频", "图片反推提示词", "文字生音乐"]) expect(markup).not.toContain(label);
        for (const label of ["GVLM 3.1", "GVLM3.1", "6 积分", "6积分"]) expect(markup).not.toContain(label);
        expect(markup).toContain("canvas-node-empty-text-mark");
        expect(markup).toContain("canvas-node-text-footer");
        expect(markup).toContain("pointer-events-none");
        expect(markup).toContain("aria-hidden");
    });

    test("does not invent a model or price when empty text metadata names one", () => {
        const node: CanvasNodeData = { id: "text-2", type: CanvasNodeType.Text, title: "文本节点 2", position: { x: 0, y: 0 }, width: 350, height: 350, metadata: { content: "", status: "idle", model: "GVLM 3.1" } };
        const markup = renderToStaticMarkup(<CanvasNodeContent node={node} theme={canvasThemes.dark} isEditingContent={false} textareaRef={createRef<HTMLTextAreaElement>()} isBatchRoot={false} batchCount={0} batchExpanded={false} batchOpening={false} batchRecovering={false} onContentChange={() => {}} onStopEditing={() => {}} mentionReferences={[]} />);
        expect(markup).not.toContain("GVLM 3.1");
        expect(markup).not.toContain("6 积分");
    });

    test("keeps the primary add-node order aligned with the LibTV palette", () => {
        const noop = () => {};
        const context: AddNodeMenuContext = {
            workspaceMode: "professional",
            isProjectLinked: false,
            handlers: {
                onAddText: noop, onAddImage: noop, onAddVideo: noop, onAddAudio: noop, onAddScript: noop,
                onAddFrame: noop, onAddFolder: noop, onAddDrawing: noop, onAddWorkflow: noop, onAddExtensionNode: noop,
                onChooseStyle: noop, onOpenDirector: noop, onUpload: noop, onOpenMyAssets: noop, onOpenProjectCharacters: noop,
            },
        };
        const labels = resolveAddNodeMenuCommands(context).filter((command) => command.section === "node").slice(0, 8).map((command) => command.label);
        expect(labels).toEqual(["文本", "图片", "视频", "AI超分", "音频", "导演台", "智能剪辑", "逐帧拉片"]);
        const commandsByLabel = new Map(resolveAddNodeMenuCommands(context).map((command) => [command.label, command]));
        for (const label of ["智能剪辑", "逐帧拉片", "脚本"]) {
            expect(commandsByLabel.get(label)?.disabledReason).toBe("正在开发");
        }
    });

    test("opens the existing director templates from the professional add-node menu", () => {
        let opened = false;
        const noop = () => {};
        const context: AddNodeMenuContext = {
            workspaceMode: "professional",
            isProjectLinked: false,
            handlers: {
                onAddText: noop, onAddImage: noop, onAddVideo: noop, onAddAudio: noop, onAddScript: noop,
                onAddFrame: noop, onAddFolder: noop, onAddDrawing: noop, onAddWorkflow: noop, onAddExtensionNode: noop,
                onChooseStyle: noop, onOpenDirector: () => { opened = true; }, onUpload: noop, onOpenMyAssets: noop, onOpenProjectCharacters: noop,
            },
        };
        const director = resolveAddNodeMenuCommands(context).find((command) => command.id === "director");
        expect(director).toBeDefined();
        expect(director?.disabledReason).toBeUndefined();
        expect(director?.badge).toBeUndefined();
        director?.run(context);
        expect(opened).toBe(true);
        expect(resolveAddNodeMenuCommands({ ...context, workspaceMode: "simple" }).some((command) => command.id === "director")).toBe(false);
    });
});
