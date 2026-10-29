import { Cable, Clock3, Eraser, Hand, Keyboard, MousePointer2, Palette, Plus, Redo2, ScanFace, Trash2, Undo2, Waypoints } from "lucide-react";

import { registerToolbarTools, type ToolDefinition } from "@/lib/canvas/tool-registry";
import type { CanvasToolMode } from "@/types/canvas";

const canvasModeOptions = [
    { id: "box-select", label: "区域选择", icon: <MousePointer2 />, value: "box-select" },
    { id: "move", label: "抓手工具", icon: <Hand />, value: "move" },
];

export const mainToolbarTools: ToolDefinition[] = [
    {
        id: "tool-appearance",
        toolbar: "main",
        category: "appearance",
        label: "画布外观",
        icon: <Palette />,
        defaultVisible: true,
        defaultOrder: 48,
        expands: true,
        active: (ctx) => ctx.appearancePanelOpen,
        run: (ctx, event) => ctx.handlers.onToggleAppearancePanel(event!),
    },
    {
        id: "tool-canvas-mode",
        toolbar: "main",
        category: "navigation",
        label: "抓手 / 框选",
        icon: <MousePointer2 />,
        defaultVisible: true,
        defaultOrder: 20,
        switchGroup: {
            value: (ctx) => ctx.canvasTool,
            options: canvasModeOptions,
            onChange: (ctx, value) => ctx.handlers.onToolChange(value as CanvasToolMode),
        },
        run: (ctx) => ctx.handlers.onToolChange(ctx.canvasTool === "move" ? "box-select" : "move"),
    },
    {
        id: "tool-undo",
        toolbar: "main",
        category: "history",
        label: "撤销",
        icon: <Undo2 />,
        defaultVisible: false,
        defaultOrder: 60,
        disabled: (ctx) => !ctx.canUndo,
        run: (ctx) => ctx.handlers.onUndo(),
    },
    {
        id: "tool-redo",
        toolbar: "main",
        category: "history",
        label: "重做",
        icon: <Redo2 />,
        defaultVisible: false,
        defaultOrder: 70,
        disabled: (ctx) => !ctx.canRedo,
        run: (ctx) => ctx.handlers.onRedo(),
    },
    {
        id: "tool-add",
        toolbar: "main",
        category: "create",
        label: "添加节点",
        icon: <Plus />,
        defaultVisible: true,
        defaultOrder: 10,
        prominent: true,
        expands: true,
        active: (ctx) => ctx.addPanelOpen,
        run: (ctx, event) => ctx.handlers.onToggleAddPanel(event!),
    },
    {
        id: "tool-assets",
        toolbar: "main",
        category: "resource",
        // LibTV 将这个入口称为“资产管理”，它承担素材浏览、上传和归档三类动作。
        // 保留原有 tool-assets id，避免用户已经保存的工具栏偏好失效。
        label: "资产管理",
        // 原版底部 Dock 使用连接/关系类图标；动作仍然保留为资产管理。
        icon: <Cable />,
        defaultVisible: true,
        defaultOrder: 30,
        applicable: (ctx) => !ctx.isProjectLinked,
        run: (ctx) => ctx.handlers.onOpenMyAssets(),
    },
    {
        id: "tool-portrait-studio",
        toolbar: "main",
        category: "resource",
        label: "人像造型室",
        icon: <ScanFace />,
        // Keep the primary dock at the LibTV reference width; the studio
        // remains available from the project/asset surfaces and toolbar settings.
        defaultVisible: false,
        defaultOrder: 45,
        run: (ctx) => ctx.handlers.onOpenProjectCharacters(),
    },
    {
        id: "tool-settings",
        toolbar: "main",
        category: "appearance",
        label: "工具栏设置",
        icon: <Waypoints />,
        defaultVisible: false,
        defaultOrder: 50,
        expands: true,
        active: (ctx) => ctx.settingsPanelOpen,
        run: (ctx) => ctx.handlers.onToggleSettingsPanel(),
    },
    {
        id: "tool-generation-history",
        toolbar: "main",
        category: "resource",
        label: "生成历史",
        icon: <Clock3 />,
        defaultVisible: true,
        defaultOrder: 55,
        run: (ctx) => ctx.handlers.onOpenGenerationHistory(),
    },
    {
        id: "tool-shortcuts",
        toolbar: "main",
        category: "navigation",
        label: "画布快捷键",
        icon: <Keyboard />,
        defaultVisible: true,
        defaultOrder: 75,
        run: (ctx) => ctx.handlers.onOpenShortcuts(),
    },
    {
        id: "tool-delete",
        toolbar: "main",
        category: "danger",
        label: (ctx) => ctx.selectedCount > 1 ? `删除 ${ctx.selectedCount} 个节点` : "删除选中节点",
        icon: <Trash2 />,
        // LibTV keeps destructive actions out of the default bottom dock;
        // they remain available through the node/canvas context menus and
        // can be re-enabled from toolbar settings.
        defaultVisible: false,
        defaultOrder: 80,
        danger: true,
        applicable: (ctx) => ctx.selectedCount > 0,
        run: (ctx) => ctx.handlers.onDeleteSelected(),
    },
    {
        id: "tool-clear",
        toolbar: "main",
        category: "danger",
        label: "清空画布",
        icon: <Eraser />,
        defaultVisible: false,
        defaultOrder: 90,
        danger: true,
        run: (ctx) => ctx.handlers.onClear(),
    },
];

registerToolbarTools(mainToolbarTools);
