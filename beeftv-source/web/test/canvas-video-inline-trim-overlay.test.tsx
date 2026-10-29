import { describe, expect, test } from "bun:test";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CanvasVideoInlineTrim, CanvasVideoInlineTrimOverlay } from "../src/components/canvas/canvas-video-inline-trim";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

const videoNode: CanvasNodeData = {
    id: "video-1",
    type: CanvasNodeType.Video,
    title: "街采替换",
    position: { x: 0, y: 0 },
    width: 720,
    height: 1280,
    metadata: { content: "blob:video", durationMs: 12_000, naturalWidth: 720, naturalHeight: 1280, hasAudio: true },
};

describe("CanvasVideoInlineTrim", () => {
    test("renders a LibTV-style filmstrip range editor with accessible cancel and confirm actions", () => {
        const html = renderToStaticMarkup(
            <CanvasVideoInlineTrim node={videoNode} busy={false} onCancel={() => {}} onConfirm={() => {}} />,
        );

        expect(html).toContain('role="dialog"');
        expect(html).toContain('aria-label="视频片段剪辑"');
        expect(html).toContain('data-video-trim-filmstrip="true"');
        expect(html).toContain('aria-label="调整片段起点"');
        expect(html).toContain('aria-label="调整片段终点"');
        expect(html).toContain('aria-label="取消剪辑"');
        expect(html).toContain('aria-label="确认剪辑"');
        expect(html).toContain('aria-label="播放片段预览"');
        expect(html).not.toContain('aria-label="静音预览"');
        expect(html).not.toContain('aria-label="关闭循环预览"');
        expect(html).toContain("12.00 s");
    });

    test("never mounts the video source as a thumbnail while frames are loading", () => {
        const html = renderToStaticMarkup(
            <CanvasVideoInlineTrim node={videoNode} busy={false} onCancel={() => {}} onConfirm={() => {}} />,
        );
        const filmstrip = html.split('class="canvas-video-trim-frames"')[1]?.split("</div>")[0] || "";

        expect(filmstrip).not.toContain("<img");
        expect(filmstrip).not.toContain("blob:video");
        expect(filmstrip.match(/<span/g)).toHaveLength(14);
    });

    test("anchors selected duration to the timeline instead of the toolbar edge", () => {
        const html = renderToStaticMarkup(
            <CanvasVideoInlineTrim node={videoNode} busy={false} onCancel={() => {}} onConfirm={() => {}} />,
        );
        const timelineGroup = html.split('class="canvas-video-trim-track"')[1]?.split('aria-label="确认剪辑"')[0] || "";

        expect(timelineGroup).toContain('aria-label="所选片段时长"');
        expect(timelineGroup).toContain("12.00 s");
        expect(html.indexOf('aria-label="所选片段时长"')).toBeLessThan(html.indexOf('aria-label="确认剪辑"'));
    });

    test("renders inside the target node panel and sizes from the rendered video width", () => {
        const html = renderToStaticMarkup(
            <CanvasVideoInlineTrimOverlay
                node={videoNode}
                viewport={{ x: 0, y: 0, k: 0.5 }}
                containerRef={createRef<HTMLDivElement>()}
                busy={false}
                onCancel={() => {}}
                onConfirm={() => {}}
            />,
        );

        expect(html).toContain("data-canvas-node-panel");
        expect(html).toContain("canvas-video-trim-overlay");
        expect(html).toContain('style="left:0;top:0;transform:translate3d(');
        expect(html).toContain("width:540px");
        expect(html).toContain('aria-label="视频片段剪辑"');
        expect(html).toContain('aria-label="确认剪辑"');
    });

    test("raises only the trim overlay above the main dock stacking rule", async () => {
        const source = await Bun.file(new URL("../src/components/canvas/canvas-video-inline-trim.tsx", import.meta.url)).text();
        const styles = await Bun.file(new URL("../src/styles/globals.css", import.meta.url)).text();
        expect(source).toContain("avoidBottomDock");
        expect(source).toContain('className="canvas-video-trim-overlay"');
        expect(styles).toContain(".canvas-video-trim-overlay {");
        expect(styles).toContain("z-index: calc(var(--z-canvas-overlay-active) + 20) !important;");
        expect(styles).toContain(".canvas-main-toolbar {");
        expect(styles).toContain("z-index: calc(var(--z-canvas-overlay-active) + 10) !important;");
    });
});
