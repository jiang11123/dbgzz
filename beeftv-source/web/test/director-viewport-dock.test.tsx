import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DirectorViewportDock } from "../src/components/canvas/director/director-viewport-dock";

describe("导演台视口变换菜单", () => {
    test("静止状态只有一个与当前模式一致的变换入口，并暴露菜单语义", () => {
        for (const [mode, label] of [["translate", "移动"], ["rotate", "旋转"], ["scale", "缩放"]] as const) {
            const html = renderToStaticMarkup(createElement(DirectorViewportDock, {
                transformMode: mode,
                renderMode: "beauty",
                renderModes: ["beauty"],
                onTransformModeChange: () => {},
                onRenderModeChange: () => {},
                timelineOpen: false,
                onToggleTimeline: () => {},
                captureBusy: false,
                captureReady: true,
                onCapture: () => {},
                onExportClay: () => {},
                exportBusy: false,
                onApplyToCanvas: () => {},
                applyBusy: false,
                saveRetryable: false,
                saveRetryBusy: false,
                onRetrySave: () => {},
            }));
            expect(html).toContain(`aria-label="${label}"`);
            expect(html).toContain('aria-haspopup="menu"');
            expect(html).not.toContain('aria-label="移动对象"');
            expect(html).not.toContain('aria-label="旋转对象"');
            expect(html).not.toContain('aria-label="缩放对象"');
            expect(html).not.toContain('aria-label="更多视口工具"');
            expect(html).not.toContain('aria-label="添加演员"');
            expect(html).not.toContain('aria-label="添加立方体"');
            expect(html).not.toContain('aria-label="构图预览"');
        }
    });

    test("底部时间轴按钮随展开状态呈现按下态", () => {
        for (const timelineOpen of [false, true]) {
            const html = renderToStaticMarkup(createElement(DirectorViewportDock, {
                transformMode: "translate", renderMode: "beauty", renderModes: ["beauty"],
                onTransformModeChange: () => {}, onRenderModeChange: () => {},
                timelineOpen, onToggleTimeline: () => {}, captureBusy: false, captureReady: true, onCapture: () => {},
                onExportClay: () => {}, exportBusy: false, onApplyToCanvas: () => {}, applyBusy: false,
                saveRetryable: false, saveRetryBusy: false, onRetrySave: () => {},
            }));
            expect(html).toContain(`aria-label="动画时间轴" aria-pressed="${timelineOpen}"`);
        }
    });

    test("三个 LibTV 常驻工具保留，导演模式和工作区状态由 dock 暴露用于审计", () => {
        const html = renderToStaticMarkup(createElement(DirectorViewportDock, {
            transformMode: "translate", renderMode: "beauty", renderModes: ["beauty"],
            onTransformModeChange: () => {}, onRenderModeChange: () => {},
            timelineOpen: false, onToggleTimeline: () => {}, captureBusy: false, captureReady: true, onCapture: () => {},
            onExportClay: () => {}, exportBusy: false, onApplyToCanvas: () => {}, applyBusy: false,
            saveRetryable: false, saveRetryBusy: false, onRetrySave: () => {},
            mode: "camera", workspaceView: "preview",
        }));
        expect(html).toContain('aria-label="导演台视口工具" data-director-mode="camera" data-workspace-view="preview"');
        expect(html).toContain('aria-label="动画时间轴"');
        expect((html.match(/aria-label="(?:移动|截图|动画时间轴)"/g) || []).length).toBe(3);
        expect(html).not.toContain('aria-label="更多视口工具"');
    });

    test("截图入口在捕获期间禁用，避免重复上传", () => {
        const render = (captureBusy: boolean, captureReady = true) => renderToStaticMarkup(createElement(DirectorViewportDock, {
            transformMode: "translate", renderMode: "beauty", renderModes: ["beauty"],
            onTransformModeChange: () => {}, onRenderModeChange: () => {},
            timelineOpen: false, onToggleTimeline: () => {}, captureBusy, captureReady, onCapture: () => {},
            onExportClay: () => {}, exportBusy: false, onApplyToCanvas: () => {}, applyBusy: false,
            saveRetryable: false, saveRetryBusy: false, onRetrySave: () => {},
        }));
        expect(render(false)).toContain('aria-label="截图"');
        expect(render(false)).not.toMatch(/aria-label="截图"[^>]*disabled/);
        expect(render(true)).toMatch(/aria-label="截图"[^>]*disabled/);
        expect(render(false, false)).toMatch(/aria-label="截图"[^>]*disabled/);
        expect(render(false, false)).toContain('title="视口加载中"');
    });
});
