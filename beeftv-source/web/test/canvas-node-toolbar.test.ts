import { describe, expect, test } from "bun:test";

import { buildImageToolbarTools } from "@/components/canvas/canvas-image-toolbar-tools";
import { resolveNodeToolbarPlacement, resolveToolbarTools, type ToolContext, type ToolbarHandlers } from "@/lib/canvas/tool-registry";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

function createNodeContext(node: CanvasNodeData): ToolContext {
    return {
        selectedCount: 0,
        selectedNodeTypes: new Set(),
        selectedVideoCount: 0,
        canvasTool: "move",
        workspaceMode: "professional",
        isProjectLinked: false,
        canUndo: false,
        canRedo: false,
        node,
        nodeMetadata: node.metadata,
        extractingVideoFrames: false,
        extractingAudio: false,
        trimmingVideo: false,
        mergingVideos: false,
        addPanelOpen: false,
        appearancePanelOpen: false,
        settingsPanelOpen: false,
        handlers: {} as ToolbarHandlers,
    };
}

describe("canvas node toolbar model", () => {
    test("opens the same subtitles action for uploaded audio and video", () => {
        for (const type of [CanvasNodeType.Audio, CanvasNodeType.Video]) {
            const node: CanvasNodeData = { id: "media", type, title: "素材", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { storageKey: "resource:media-fixture" } };
            const ctx = createNodeContext(node);
            const received: CanvasNodeData[] = [];
            ctx.handlers = { onNodeSubtitles: target => received.push(target) } as ToolbarHandlers;
            const action = resolveToolbarTools("node-hover", ctx, null).find(tool => tool.id === "subtitles");
            expect(action).toBeDefined();
            action?.run(ctx);
            expect(received).toEqual([node]);
        }
    });
    test("preserves empty, simple and busy video states", () => {
        const ctx = createNodeContext({ id: "video", type: CanvasNodeType.Video, title: "视频", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: {} });
        const emptyTools = resolveToolbarTools("node-hover", ctx, null);
        expect(emptyTools.some((tool) => tool.id === "extractAudio")).toBe(false);
        expect(emptyTools.some((tool) => tool.id === "uploadVideo")).toBe(false);
        ctx.nodeMetadata = { content: "video.mp4" };
        const uploadedTools = resolveToolbarTools("node-hover", ctx, null);
        expect(resolveNodeToolbarPlacement(uploadedTools.find((tool) => tool.id === "uploadVideo")!, ctx).group).toBe("more");
        ctx.extractingAudio = true;
        const audio = resolveToolbarTools("node-hover", ctx, null).find((tool) => tool.id === "extractAudio")!;
        expect(audio.disabled?.(ctx)).toBe(true);
        ctx.workspaceMode = "simple";
        expect(resolveToolbarTools("node-hover", ctx, null).some((tool) => tool.id === "extractAudio")).toBe(false);
    });

    test("image menu actions remain lazy and keep the original node", () => {
        const node: CanvasNodeData = { id: "image", type: CanvasNodeType.Image, title: "图片", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { content: "image.png", freeResize: true } };
        const received: CanvasNodeData[] = [];
        const tools = buildImageToolbarTools(node, { onCrop: (target: CanvasNodeData) => received.push(target) } as never);
        expect(received).toEqual([]);
        tools.find((tool) => tool.id === "crop")!.onClick();
        expect(received).toEqual([node]);
        expect(tools.find((tool) => tool.id === "resize")?.active).toBe(false);
    });

    test("keeps video primary actions compact and moves secondary processing into a menu", () => {
        const ctx = createNodeContext({ id: "video", type: CanvasNodeType.Video, title: "视频", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { content: "video.mp4" } });
        const tools = resolveToolbarTools("node-hover", ctx, null);
        const groups = new Map(tools.map((tool) => [tool.id, resolveNodeToolbarPlacement(tool, ctx).group]));

        expect([...groups].filter(([, group]) => group === "primary").map(([id]) => id)).toEqual(["trimRegenerate", "subtitles"]);
        expect([...groups].filter(([, group]) => group === "process").map(([id]) => id)).toEqual(["extractFrames", "extractAudio"]);
        expect(groups.get("download")).toBe("utility");
        expect(groups.get("timeline")).toBe("workspace");
        expect(groups.get("uploadVideo")).toBe("more");
        expect(groups.get("delete")).toBe("more");
        expect(groups.get("node-lock")).toBe("more");
    });

    test("offers depth capture as a video processing action and dispatches the source node", () => {
        const node: CanvasNodeData = { id: "video", type: CanvasNodeType.Video, title: "视频", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { content: "video.mp4" } };
        const received: CanvasNodeData[] = [];
        const ctx = createNodeContext(node);
        ctx.handlers = { onNodeDepthCapture: (target) => received.push(target) } as ToolbarHandlers;

        const tool = resolveToolbarTools("node-hover", ctx, null).find((item) => item.id === "depthCapture");

        expect(tool).toBeDefined();
        expect(tool?.displayLabel).toBe("深度动作捕捉");
        expect(resolveNodeToolbarPlacement(tool!, ctx).group).toBe("more");
        expect(tool?.nodeToolbar?.section).toBe("视频处理");
        tool?.run(ctx);
        expect(received).toEqual([node]);
    });

    test("uses the redesigned video terminology from the registry", () => {
        const ctx = createNodeContext({ id: "video", type: CanvasNodeType.Video, title: "视频", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { content: "video.mp4" } });
        const tools = new Map(resolveToolbarTools("node-hover", ctx, null).map((tool) => [tool.id, tool]));
        const displayLabel = (id: string) => {
            const value = tools.get(id)?.displayLabel;
            return typeof value === "function" ? value(ctx) : value;
        };

        expect(displayLabel("subtitles")).toBe("字幕");
        expect(displayLabel("timeline")).toBe("进入剪辑");
        expect(displayLabel("extractFrames")).toBe("关键帧截取");
        expect(displayLabel("extractAudio")).toBe("音视频分离");
    });

    test.each([CanvasNodeType.Audio, CanvasNodeType.Video])("opens the project timeline from a %s node", (type) => {
        const node: CanvasNodeData = { id: "media", type, title: "素材", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { storageKey: "resource:media-fixture" } };
        const ctx = createNodeContext(node);
        const received: CanvasNodeData[] = [];
        ctx.handlers = { onNodeTimeline: (target) => received.push(target) } as ToolbarHandlers;
        const timeline = resolveToolbarTools("node-hover", ctx, null).find((tool) => tool.id === "timeline");
        expect(timeline?.displayLabel).toBe("进入剪辑");
        expect(resolveNodeToolbarPlacement(timeline!, ctx).group).toBe("workspace");
        timeline?.run(ctx);
        expect(received).toEqual([node]);
    });

    test("image-only tools carry presentation metadata instead of relying on component ID lists", () => {
        const node: CanvasNodeData = { id: "image", type: CanvasNodeType.Image, title: "图片", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { content: "image.png" } };
        const tools = buildImageToolbarTools(node, {} as never);

        expect(tools.find((tool) => tool.id === "angle")?.group).toBe("viewpoint");
        expect(tools.find((tool) => tool.id === "maskEdit")?.group).toBe("primary");
        expect(tools.some((tool) => tool.id === "superResolve")).toBe(false);
        expect(tools.find((tool) => tool.id === "emotion")?.group).toBe("portrait");
        expect(tools.find((tool) => tool.id === "upscale")?.description).toContain("不是 AI 超分");
        expect(tools.find((tool) => tool.id === "crop")?.section).toBe("构图与尺寸");
        expect(tools.find((tool) => tool.id === "resize")?.active).toBe(true);
        expect(tools.find((tool) => tool.id === "copyPrompt")?.group).toBe("more");
    });
});
