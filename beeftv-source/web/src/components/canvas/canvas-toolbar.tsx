import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { Hand, MousePointer2, ScanFace } from "lucide-react";

import { FloatingDock, type FloatingDockCommand } from "@/components/ui/aceternity/floating-dock";
import { SpotlightSurface } from "@/components/ui/aceternity/spotlight-surface";
import { useCanvasOverlayLayer } from "@/components/canvas/canvas-overlay-layer";
import { CanvasCreateMenu, type CanvasCreateCommand } from "@/components/canvas/canvas-create-menu";
import { useCanvasCreateCommands } from "@/components/canvas/use-canvas-create-commands";
import { ToolbarSettingsModal } from "@/components/canvas/toolbars/toolbar-settings-modal";
import { CanvasAppearanceControls } from "@/components/canvas/canvas-appearance-controls";
import { CanvasShortcutsPopover } from "@/components/canvas/canvas-shortcuts-popover";
import { aceternityMotion } from "@/lib/aceternity-motion";
import { canvasDockStyle } from "@/lib/canvas/canvas-aceternity-style";
import type { CanvasAppearance } from "@/lib/canvas/canvas-appearance";
import { canvasThemes, type CanvasBackgroundMode, type CanvasTheme } from "@/lib/canvas-theme";
import { defaultToolbarPrefs, readToolbarPrefs, resolveToolbarEntries, type ToolContext, type ToolbarHandlers, type ToolbarPrefs } from "@/lib/canvas/tool-registry";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";
import type { CanvasNodeTypeId, CanvasToolMode, CanvasWorkspaceMode, DoubaoNodeTaskMode } from "@/types/canvas";

export function CanvasToolbar({
    selectedCount,
    libtvChrome = false,
    workspaceMode,
    canvasTool,
    onToolChange,
    isProjectLinked,
    canUndo,
    canRedo,
    appearance,
    backgroundMode,
    showImageInfo,
    onAddImage,
    onAddVideo,
    onAddAudio,
    onAddText,
    onChooseStyle,
    onAddScript,
    onAddFrame,
    onAddFolder,
    onAddDrawing,
    onAddExtensionNode,
    onAddDoubaoAccountNode,
    onAddWorkflow,
    onOpenDirector,
    onUndo,
    onRedo,
    onUpload,
    onDelete,
    onClear,
    onDeselect,
    onAppearanceChange,
    onSaveAppearanceDefault,
    onBackgroundModeChange,
    snapToGrid,
    onSnapToGridChange,
    showConnections,
    onShowConnectionsChange,
    onShowImageInfoChange,
    onOpenMyAssets,
    onOpenProjectCharacters,
    onOpenGenerationHistory,
    shortcutRequestNonce,
}: {
    selectedCount: number;
    /** 兼容 LibTV 视觉基线时，仅显示原版底部 Dock 的核心入口。 */
    libtvChrome?: boolean;
    workspaceMode: CanvasWorkspaceMode;
    canvasTool: CanvasToolMode;
    onToolChange: (tool: CanvasToolMode) => void;
    isProjectLinked: boolean;
    canUndo: boolean;
    canRedo: boolean;
    appearance: CanvasAppearance;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    onAddImage: () => void;
    onAddVideo: () => void;
    onAddAudio: () => void;
    onAddText: () => void;
    onChooseStyle: () => void;
    onAddScript: () => void;
    onAddFrame: () => void;
    onAddFolder: () => void;
    onAddDrawing: () => void;
    onAddExtensionNode: (type: CanvasNodeTypeId) => void;
    onAddDoubaoAccountNode: (mode: DoubaoNodeTaskMode) => void;
    onAddWorkflow: () => void;
    onOpenDirector: () => void;
    onUndo: () => void;
    onRedo: () => void;
    onUpload: () => void;
    onDelete: () => void;
    onClear: () => void;
    onDeselect: () => void;
    onAppearanceChange: (appearance: CanvasAppearance) => void;
    onSaveAppearanceDefault: (appearance: CanvasAppearance) => void;
    onBackgroundModeChange: (mode: CanvasBackgroundMode) => void;
    snapToGrid: boolean;
    onSnapToGridChange: (enabled: boolean) => void;
    showConnections: boolean;
    onShowConnectionsChange: (visible: boolean) => void;
    onShowImageInfoChange: (show: boolean) => void;
    onOpenMyAssets: () => void;
    onOpenProjectCharacters: () => void;
    onOpenGenerationHistory: () => void;
    shortcutRequestNonce: number;
}) {
    const rootRef = useRef<HTMLDivElement>(null);
    // Keep the overlay-layer contract for focus ordering; the dedicated CSS
    // layer below lifts the dock above expanded node panels while staying below
    // the Agent drawer.
    const { bringToFront, zIndex } = useCanvasOverlayLayer("main-toolbar", "calc(var(--z-modal-overlay) + 10)");
    const dockRef = useRef<HTMLDivElement>(null);
    const colorTheme = useActiveTheme();
    const theme = canvasThemes[colorTheme];
    const [addOpen, setAddOpen] = useState(false);
    const [appearanceOpen, setAppearanceOpen] = useState(false);
    const [modeMenuOpen, setModeMenuOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [shortcutsOpen, setShortcutsOpen] = useState(false);
    const lastShortcutRequest = useRef(shortcutRequestNonce);
    const [panelX, setPanelX] = useState(0);
    const [prefs, setPrefs] = useState<ToolbarPrefs | null>(() => readToolbarPrefs("main"));

    useEffect(() => {
        if (addOpen || modeMenuOpen || appearanceOpen || shortcutsOpen) bringToFront();
    }, [addOpen, modeMenuOpen, appearanceOpen, shortcutsOpen, bringToFront]);

    useEffect(() => {
        if (lastShortcutRequest.current === shortcutRequestNonce) return;
        lastShortcutRequest.current = shortcutRequestNonce;
        const button = dockRef.current?.querySelector<HTMLElement>('[aria-label="画布快捷键"]');
        if (button) setPanelX(getPanelX(dockRef.current, button));
        setAddOpen(false);
        setAppearanceOpen(false);
        setModeMenuOpen(false);
        setSettingsOpen(false);
        setShortcutsOpen(true);
    }, [shortcutRequestNonce]);

    // 设置面板关闭后重新读取偏好（用户可能调整了排序/显隐）
    useEffect(() => {
        if (!settingsOpen) setPrefs(readToolbarPrefs("main"));
    }, [settingsOpen]);

    const placePanel = (event: ReactMouseEvent<HTMLElement>) => setPanelX(getPanelX(dockRef.current, event.currentTarget));
    const runAddAction = (action: () => void) => {
        action();
        setAddOpen(false);
    };

    // 点击外部关闭浮层面板
    useEffect(() => {
        if (!addOpen && !modeMenuOpen && !appearanceOpen && !shortcutsOpen) return;
        const closeFloatingPanels = (event: PointerEvent) => {
            const target = event.target instanceof Node ? event.target : null;
            if (target && rootRef.current?.contains(target)) return;
            const element = event.target instanceof Element ? event.target : null;
            if (element?.closest(".ant-color-picker,.ant-popover")) return;
            setAddOpen(false);
            setModeMenuOpen(false);
            setAppearanceOpen(false);
            setShortcutsOpen(false);
        };
        document.addEventListener("pointerdown", closeFloatingPanels, true);
        return () => document.removeEventListener("pointerdown", closeFloatingPanels, true);
    }, [addOpen, modeMenuOpen, appearanceOpen, shortcutsOpen]);

    useEffect(() => {
        if (!shortcutsOpen) return;
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            setShortcutsOpen(false);
            dockRef.current?.querySelector<HTMLButtonElement>('[aria-label="画布快捷键"]')?.focus();
        };
        window.addEventListener("keydown", closeOnEscape, true);
        return () => window.removeEventListener("keydown", closeOnEscape, true);
    }, [shortcutsOpen]);

    // Match LibTV's tool shortcuts. Ignore editable surfaces so typing a
    // prompt never changes the canvas interaction mode.
    useEffect(() => {
        const handleToolShortcut = (event: KeyboardEvent) => {
            if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
            const target = event.target instanceof HTMLElement ? event.target : null;
            if (target?.isContentEditable || target?.closest("input, textarea, select, [contenteditable='true']")) return;
            const key = event.key.toLowerCase();
            if (key !== "v" && key !== "h") return;
            event.preventDefault();
            onToolChange(key === "h" ? "move" : "box-select");
            setModeMenuOpen(false);
        };
        window.addEventListener("keydown", handleToolShortcut);
        return () => window.removeEventListener("keydown", handleToolShortcut);
    }, [onToolChange]);

    // 构建 handlers（主工具栏只需要部分回调，其余用 no-op 占位满足类型）
    const handlers: ToolbarHandlers = {
        onToolChange,
        onDeselect,
        onUndo,
        onRedo,
        onClear,
        onAddText,
        onAddImage,
        onAddVideo,
        onAddAudio,
        onAddScript,
        onAddFrame,
        onAddFolder,
        onAddDrawing,
        onAddExtensionNode,
        onAddDoubaoAccountNode,
        onAddWorkflow,
        onChooseStyle,
        onOpenDirector,
        onUpload,
        onOpenMyAssets,
        onOpenProjectCharacters,
        onOpenGenerationHistory,
        onOpenShortcuts: () => setShortcutsOpen((value) => !value),
        onBackgroundModeChange,
        onShowImageInfoChange,
        onToggleAddPanel: (event: ReactMouseEvent<HTMLElement>) => { placePanel(event); setShortcutsOpen(false); setAppearanceOpen(false); setModeMenuOpen(false); setSettingsOpen(false); setAddOpen((value) => !value); },
        onToggleAppearancePanel: (event: ReactMouseEvent<HTMLElement>) => { placePanel(event); setShortcutsOpen(false); setAddOpen(false); setModeMenuOpen(false); setSettingsOpen(false); setAppearanceOpen((value) => !value); },
        onToggleSettingsPanel: () => { setShortcutsOpen(false); setAddOpen(false); setAppearanceOpen(false); setModeMenuOpen(false); setSettingsOpen((value) => !value); },
        onDeleteSelected: onDelete,
        // 以下为多选/节点悬停工具栏回调，主工具栏不使用，用 no-op 占位
        onAlign: () => {}, onArrange: () => {}, onCreateStoryboard: () => {}, onCreateReferenceGroup: () => {}, onBatchConnect: () => {}, onMergeVideos: () => {},
        onNodeInfo: () => {}, onNodeDelete: () => {}, onNodeRetry: () => {}, onNodeEditText: () => {}, onNodeDecreaseFont: () => {}, onNodeIncreaseFont: () => {},
        onNodeToggleDialog: () => {}, onNodeAnnotate: () => {}, onNodeGenerateImage: () => {}, onNodeUpload: () => {}, onNodeDownload: () => {}, onNodeSaveAsset: () => {},
        onNodeMaskEdit: () => {}, onNodeEmotion: () => {}, onNodePortraitTexture: () => {}, onNodeCrop: () => {}, onNodeSplit: () => {}, onNodeUpscale: () => {},
        onNodeSuperResolve: () => {}, onNodeAngle: () => {}, onNodeViewImage: () => {}, onNodeExtractVideoFrames: () => {}, onNodeExtractAudioFromVideo: () => {}, onNodeTrimVideoSegments: () => {}, onNodeCropVideo: () => {}, onNodeDepthCapture: () => {}, onNodeSubtitles: () => {}, onNodeTimeline: () => {}, onNodeReversePrompt: () => {},
        onNodeToggleFreeResize: () => {}, onNodeToggleLocked: () => {}, onNodeCopyPrompt: () => {},
    } as ToolbarHandlers;

    const ctx: ToolContext = {
        selectedCount,
        selectedNodeTypes: new Set(),
        selectedVideoCount: 0,
        canvasTool,
        workspaceMode,
        isProjectLinked,
        canUndo,
        canRedo,
        extractingVideoFrames: false,
        extractingAudio: false,
        trimmingVideo: false,
        mergingVideos: false,
        addPanelOpen: addOpen,
        appearancePanelOpen: appearanceOpen,
        settingsPanelOpen: settingsOpen,
        handlers,
    };

    const resolvedMainItems = resolveToolbarEntries("main", ctx, prefs ?? defaultToolbarPrefs("main"));
    const libtvMainItems = resolvedMainItems;
    const mainItemsWithCanvasMode = libtvMainItems.map((item) => item.id === "tool-canvas-mode"
        ? createCanvasModeDockCommand(canvasTool, modeMenuOpen, (event) => {
            placePanel(event);
            setShortcutsOpen(false);
            setAddOpen(false);
            setAppearanceOpen(false);
            setSettingsOpen(false);
            setModeMenuOpen((value) => !value);
        })
        : item.id === "tool-shortcuts" ? {
            ...item,
            active: shortcutsOpen,
            expands: true,
            onClick: (event: ReactMouseEvent<HTMLButtonElement>) => {
                placePanel(event);
                setAddOpen(false);
                setAppearanceOpen(false);
                setModeMenuOpen(false);
                setSettingsOpen(false);
                setShortcutsOpen((value) => !value);
            },
        } : item);
    const items = [
        ...mainItemsWithCanvasMode,
        ...(libtvChrome ? [
            {
                id: "tool-portrait-studio",
                label: "人像造型室",
                icon: <ScanFace />,
                onClick: onOpenProjectCharacters,
            },
        ] : []),
    ];

    // 中央空白起点与主工具栏共用同一份命令解析，避免素材类型和插件节点逐渐分叉。
    const createCommands = useCanvasCreateCommands(ctx, runAddAction);

    return (
        <div ref={rootRef} data-onboarding="canvas-tools" data-canvas-no-zoom className={`canvas-main-toolbar pointer-events-none absolute inset-x-[var(--canvas-inset-x)] bottom-[var(--canvas-inset-y)] flex justify-center${libtvChrome ? " canvas-libtv-compat-toolbar" : ""}`} style={{ zIndex }} onPointerDownCapture={bringToFront} onFocusCapture={bringToFront}>
            {shortcutsOpen ? <CanvasShortcutsPopover x={panelX} theme={theme} /> : null}
            <AnimatePresence>
                {modeMenuOpen ? (
                    <CanvasModeMenu
                        canvasTool={canvasTool}
                        x={panelX}
                        onSelect={(tool) => {
                            onToolChange(tool);
                            setModeMenuOpen(false);
                        }}
                    />
                ) : null}
            </AnimatePresence>

            <AnimatePresence>
                {addOpen ? (
                    <AddNodeMenu
                        x={panelX}
                        theme={theme}
                        commands={createCommands}
                    />
                ) : null}
            </AnimatePresence>

            {appearanceOpen ? (
                <div role="dialog" aria-label="画布外观" className="pointer-events-auto absolute bottom-[var(--canvas-dock-popover-offset)] w-[288px] max-w-[calc(100vw-24px)] max-h-[70vh] overflow-y-auto rounded-[18px] border p-4 shadow-xl" style={{ left: "50%", transform: "translateX(-50%)", background: theme.node.fill, borderColor: theme.toolbar.border, color: theme.node.text }} onWheel={(event) => event.stopPropagation()}>
                    <div className="text-sm font-semibold">画布外观</div>
                    <CanvasAppearanceControls appearance={appearance} backgroundMode={backgroundMode} colorTheme={colorTheme} theme={theme} onAppearanceChange={onAppearanceChange} onSaveAppearanceDefault={onSaveAppearanceDefault} onBackgroundModeChange={onBackgroundModeChange} snapToGrid={snapToGrid} onSnapToGridChange={onSnapToGridChange} showConnections={showConnections} onShowConnectionsChange={onShowConnectionsChange} />
                </div>
            ) : null}

            <FloatingDock
                ref={dockRef}
                items={items}
                size="libtv"
                // 宽度随实际命令数量收缩，避免末尾留下无功能的空白区域；窄屏仍由 FloatingDock 自己滚动收缩。
                className="canvas-floating-dock libtv-main-dock pointer-events-auto max-w-full"
                style={canvasDockStyle(theme)}
            />
            {libtvChrome ? (
                <button type="button" className="canvas-libtv-director-entry pointer-events-auto" onClick={onOpenDirector} aria-label="TV Director">
                    <span className="canvas-libtv-director-orb" aria-hidden="true" />
                    <span>TV Director</span>
                </button>
            ) : null}

            <ToolbarSettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} toolbar="main" />
        </div>
    );
}

export function createCanvasModeDockCommand(
    canvasTool: CanvasToolMode,
    open: boolean,
    onClick: NonNullable<FloatingDockCommand["onClick"]>,
): FloatingDockCommand {
    const grabbing = canvasTool === "move";
    return {
        kind: "command",
        id: "tool-canvas-mode-trigger",
        label: grabbing ? "抓手工具" : "移动",
        icon: grabbing ? <Hand /> : <MousePointer2 />,
        active: open,
        expands: true,
        onClick,
    };
}

export function CanvasModeMenu({ canvasTool, x, onSelect }: {
    canvasTool: CanvasToolMode;
    x: number;
    onSelect: (tool: CanvasToolMode) => void;
}) {
    const options: Array<{ tool: CanvasToolMode; label: string; shortcut: string; icon: ReactNode }> = [
        { tool: "box-select", label: "移动", shortcut: "V", icon: <MousePointer2 /> },
        { tool: "move", label: "抓手工具", shortcut: "H", icon: <Hand /> },
    ];
    return (
        <motion.div
            role="menu"
            aria-label="画布操作工具"
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 6, transition: { duration: 0.08 } }}
            transition={{ duration: aceternityMotion.duration.instant, ease: aceternityMotion.easing.enter }}
            className="canvas-mode-menu pointer-events-auto absolute bottom-[var(--canvas-dock-popover-offset)] z-[var(--dock-z-popover)] w-[224px] rounded-[18px] border p-2"
            style={{ left: x || "50%", x: "-50%", transformOrigin: "bottom center" }}
        >
            {options.map((option) => {
                const active = option.tool === canvasTool;
                return (
                    <button
                        key={option.tool}
                        type="button"
                        role="menuitemradio"
                        aria-checked={active}
                        className="canvas-mode-menu-item flex h-12 w-full items-center gap-3 rounded-[12px] px-3 text-left"
                        onClick={() => onSelect(option.tool)}
                    >
                        <span className="grid size-6 place-items-center [&_svg]:size-6" aria-hidden>{option.icon}</span>
                        <span className="flex-1 text-[15px] font-medium">{option.label}</span>
                        <kbd className="text-sm font-medium">{option.shortcut}</kbd>
                    </button>
                );
            })}
            <span className="canvas-mode-menu-caret" aria-hidden />
        </motion.div>
    );
}

function AddNodeMenu({ x, theme, commands }: {
    x: number;
    theme: CanvasTheme;
    commands: CanvasCreateCommand[];
}) {
    return (
        <motion.div initial={{ opacity: 0, scaleY: 0.9, y: 8 }} animate={{ opacity: 1, scaleY: 1, y: 0 }} exit={{ opacity: 0, scaleY: 0.92, y: 6 }} transition={{ duration: aceternityMotion.duration.panel, ease: aceternityMotion.easing.enter }} className="pointer-events-auto absolute bottom-[var(--canvas-dock-popover-offset)] z-[var(--dock-z-popover)] w-[232px] max-w-[calc(100vw-24px)]" style={{ left: x || "50%", transformOrigin: "bottom center", x: "-50%" }}>
            <SpotlightSurface spotlightColor={theme.toolbar.itemHover} initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.97, transition: { duration: 0 } }} transition={{ duration: aceternityMotion.duration.instant, ease: aceternityMotion.easing.enter }} className="canvas-create-menu-surface aceternity-floating-panel overflow-hidden rounded-[18px] border p-2 backdrop-blur-2xl" style={{ background: theme.node.fill, borderColor: theme.toolbar.border, color: theme.node.text }} onWheel={(event) => event.stopPropagation()}>
                <CanvasCreateMenu commands={commands} layout="list" />
            </SpotlightSurface>
        </motion.div>
    );
}

function getPanelX(dock: HTMLDivElement | null, target: HTMLElement) {
    if (!dock) return 0;
    const rootBox = dock.parentElement?.getBoundingClientRect() || dock.getBoundingClientRect();
    const box = target.getBoundingClientRect();
    return box.left - rootBox.left + box.width / 2;
}
