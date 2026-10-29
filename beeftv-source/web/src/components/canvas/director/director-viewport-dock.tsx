import { Dropdown, type MenuProps } from "antd";
import type { MenuInfo } from "rc-menu/lib/interface";

import { Bone, Camera, Clapperboard, Compass, Layers, LoaderCircle, MousePointer2, Palette, Rotate3D, RotateCcw, Save, Scaling, Video } from "lucide-react";
import { useState, type ReactNode } from "react";

import { releaseDirectorFocusAfterPointer } from "@/lib/canvas/director/director-shortcuts";
import { DIRECTOR_MODES, type DirectorMode } from "@/lib/canvas/director/director-modes";
import type { DirectorRenderMode } from "@/types/director";

type DirectorViewportDockProps = {
    transformMode: "translate" | "rotate" | "scale";
    renderMode: DirectorRenderMode;
    /** 当前模式允许的渲染视图。dock 只展示这些，避免成为绕过模式门控的第二条路径。 */
    renderModes: DirectorRenderMode[];
    onTransformModeChange: (mode: DirectorViewportDockProps["transformMode"]) => void;
    onRenderModeChange: (mode: DirectorRenderMode) => void;
    timelineOpen: boolean;
    onToggleTimeline: () => void;
    captureBusy: boolean;
    captureReady: boolean;
    onCapture: () => void;
    onExportClay: () => void;
    exportBusy: boolean;
    onApplyToCanvas: () => void;
    applyBusy: boolean;
    saveRetryable: boolean;
    saveRetryBusy: boolean;
    onRetrySave: () => void;
    mode?: DirectorMode;
    onModeChange?: (mode: DirectorMode) => void;
    workspaceView?: "scene" | "preview";
    onWorkspaceViewChange?: (view: "scene" | "preview") => void;
    canUndo?: boolean;
    canRedo?: boolean;
    onUndo?: () => void;
    onRedo?: () => void;
};

/** 渲染视图按钮的展示顺序与图标。实际可见项由 renderModes 过滤。 */
const RENDER_VIEW_BUTTONS: Array<{ mode: DirectorRenderMode; label: string; icon: ReactNode }> = [
    { mode: "beauty", label: "构图预览", icon: <Camera /> },
    { mode: "clay", label: "彩色白膜", icon: <Palette /> },
    { mode: "pose", label: "骨骼视图", icon: <Bone /> },
    { mode: "depth", label: "深度视图", icon: <Layers /> },
    { mode: "normal", label: "法线视图", icon: <Compass /> },
];

const TRANSFORM_BUTTONS = [
    { mode: "translate", label: "移动", shortcut: "V", icon: <MousePointer2 /> },
    { mode: "rotate", label: "旋转", shortcut: "R", icon: <Rotate3D /> },
    { mode: "scale", label: "缩放", shortcut: "F", icon: <Scaling /> },
] as const;

export function DirectorViewportDock({ transformMode, renderMode, renderModes, onTransformModeChange, onRenderModeChange, timelineOpen, onToggleTimeline, captureBusy, captureReady, onCapture, onExportClay, exportBusy, onApplyToCanvas, applyBusy, saveRetryable, saveRetryBusy, onRetrySave, mode = "layout", onModeChange = () => {}, workspaceView = "scene", onWorkspaceViewChange = () => {}, canUndo = false, canRedo = false, onUndo = () => {}, onRedo = () => {} }: DirectorViewportDockProps) {
    const [advancedMenu, setAdvancedMenu] = useState(false);
    const activeTransform = TRANSFORM_BUTTONS.find((item) => item.mode === transformMode) ?? TRANSFORM_BUTTONS[0];
    const releaseMenuFocus = (detail: number) => releaseDirectorFocusAfterPointer({ detail, currentTarget: document.activeElement as HTMLElement });
    const toolMenuItems: NonNullable<MenuProps["items"]> = [
        { type: "group" as const, key: "render", label: "视图模式", children: RENDER_VIEW_BUTTONS.filter((item) => renderModes.includes(item.mode)).map((item) => ({ key: `render-${item.mode}`, icon: item.icon, label: item.label, onClick: ({ domEvent }) => { onRenderModeChange(item.mode); releaseMenuFocus(domEvent.detail); } })) },
        { type: "group" as const, key: "workbench", label: "工作台", children: [
            { key: "export-clay", icon: exportBusy ? <LoaderCircle className="animate-spin" /> : <Video />, label: exportBusy ? "正在导出白膜视频" : "导出白膜视频", disabled: exportBusy, onClick: ({ domEvent }) => { onExportClay(); releaseMenuFocus(domEvent.detail); } },
            { key: "apply-to-canvas", icon: applyBusy ? <LoaderCircle className="animate-spin" /> : <Save />, label: applyBusy ? "正在应用到镜头" : "应用到镜头", disabled: applyBusy, onClick: ({ domEvent }) => { onApplyToCanvas(); releaseMenuFocus(domEvent.detail); } },
            ...(saveRetryable ? [{ key: "retry-save", icon: saveRetryBusy ? <LoaderCircle className="animate-spin" /> : <RotateCcw />, label: saveRetryBusy ? "正在重试保存" : "重试保存", disabled: saveRetryBusy, onClick: ({ domEvent }: MenuInfo) => { onRetrySave(); releaseMenuFocus(domEvent.detail); } }] : []),
        ] },
        { key: "director-navigation", label: "导演台导航", icon: <Layers />, children: [
            { type: "group" as const, key: "director-mode", label: "导演台模式", children: DIRECTOR_MODES.map((item) => ({ key: `director-mode-${item.mode}`, label: item.label, title: item.hint, onClick: ({ domEvent }) => { onModeChange(item.mode); releaseMenuFocus(domEvent.detail); } })) },
            { type: "group" as const, key: "workspace-view", label: "工作区视图", children: [
                { key: "workspace-scene", label: "场景调度", onClick: ({ domEvent }) => { onWorkspaceViewChange("scene"); releaseMenuFocus(domEvent.detail); } },
                { key: "workspace-preview", label: "成片预演", onClick: ({ domEvent }) => { onWorkspaceViewChange("preview"); releaseMenuFocus(domEvent.detail); } },
            ] },
            { type: "group" as const, key: "history", label: "编辑历史", children: [
                { key: "undo", icon: <RotateCcw />, label: "撤销", disabled: !canUndo, onClick: ({ domEvent }) => { onUndo(); releaseMenuFocus(domEvent.detail); } },
                { key: "redo", icon: <RotateCcw className="scale-x-[-1]" />, label: "重做", disabled: !canRedo, onClick: ({ domEvent }) => { onRedo(); releaseMenuFocus(domEvent.detail); } },
            ] },
        ] },
    ];
    const transformMenuItems: NonNullable<MenuProps["items"]> = [
        ...TRANSFORM_BUTTONS.map((item) => ({
            key: item.mode,
            icon: item.icon,
            label: <span className="flex min-w-24 items-center justify-between gap-5"><span>{item.label}</span><span className="text-xs opacity-60">{item.shortcut}</span></span>,
            onClick: ({ domEvent }: MenuInfo) => { onTransformModeChange(item.mode); releaseMenuFocus(domEvent.detail); },
        })),
    ];
    return (
        <nav className="director-viewport-dock" aria-label="导演台视口工具" data-director-mode={mode} data-workspace-view={workspaceView}>
            <Dropdown
                trigger={["click", "contextMenu"]}
                placement="topLeft"
                menu={{
                    selectable: true,
                    selectedKeys: [transformMode, `render-${renderMode}`, `director-mode-${mode}`, `workspace-${workspaceView}`],
                    items: advancedMenu ? toolMenuItems : transformMenuItems,
                }}
            >
                <button type="button" className="director-viewport-dock-button is-active" aria-label={activeTransform.label} aria-haspopup="menu" title={`${activeTransform.label} (${activeTransform.shortcut}) · 右键更多工具`} onClick={() => setAdvancedMenu(false)} onContextMenu={() => setAdvancedMenu(true)}>
                    {activeTransform.icon}
                </button>
            </Dropdown>
            <button type="button" className="director-viewport-dock-button disabled:opacity-40" aria-label="截图" disabled={captureBusy || !captureReady} title={captureBusy ? "正在保存截图" : captureReady ? "截图" : "视口加载中"} onClick={(event) => { onCapture(); releaseDirectorFocusAfterPointer(event); }}>{captureBusy ? <LoaderCircle className="animate-spin" /> : <Camera />}</button>
            <button type="button" className={`director-viewport-dock-button ${timelineOpen ? "is-active" : ""}`} aria-label="动画时间轴" aria-pressed={timelineOpen} onClick={(event) => { onToggleTimeline(); releaseDirectorFocusAfterPointer(event); }}><Clapperboard /></button>
        </nav>
    );
}
