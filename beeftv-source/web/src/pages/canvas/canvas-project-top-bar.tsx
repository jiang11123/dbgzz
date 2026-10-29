import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router";
import { Check, ChevronDown, ChevronUp, Clapperboard, CloudUpload, Columns2, CopyPlus, Focus, FolderKanban, Gauge, History, Home, LayoutGrid, MoreHorizontal, Pencil, Plus, Redo2, Save, Search, Sparkles, Trash2, Undo2, Upload, Workflow, X } from "lucide-react";
import { Button, Dropdown, Tooltip } from "antd";

import { BrandLogoFrame } from "@/components/brand/brand-logo";
import { canvasDockStyle } from "@/lib/canvas/canvas-aceternity-style";
import type { CanvasContextSummary } from "@/lib/canvas/canvas-context-summary";
import type { CanvasShortDramaProgress } from "@/lib/canvas/canvas-short-drama";
import { canvasThemes } from "@/lib/canvas-theme";
import { useCanvasThemeStore } from "@/stores/canvas/use-canvas-theme-store";
import type { CanvasMediaPerformanceMode } from "@/types/canvas";

type CanvasTopBarProps = {
    workspaceView: "workflow" | "storyboard";
    onWorkspaceViewChange: (view: "workflow" | "storyboard") => void;
    syncStatus?: ReactNode;
    versionsOpen: boolean;
    onToggleVersions: () => void;
    onOpenWorkflows?: () => void;
    workflowsOpen?: boolean;
    assistantOpen?: boolean;
    onToggleAssistant?: () => void;
    title: string;
    titleDraft: string;
    isTitleEditing: boolean;
    onTitleDraftChange: (value: string) => void;
    onStartTitleEditing: () => void;
    onFinishTitleEditing: () => void;
    onCancelTitleEditing: () => void;
    canUndo: boolean;
    canRedo: boolean;
    onCreateCanvas: () => void;
    projectCanvases?: Array<{ id: string; title: string }>;
    currentCanvasId?: string;
    onSwitchCanvas?: (id: string) => void;
    onOpenCanvasInNewWindow?: (id: string) => void;
    onRenameCanvas?: (id: string, title: string) => void | Promise<void>;
    onDuplicateCanvas?: (id: string) => void | Promise<void>;
    onDeleteCanvas?: (id: string) => void | Promise<void>;
    onDeleteProject: () => void;
    onSave: () => void | Promise<void>;
    onForceSave: () => void;
    onImportImage: () => void;
    onImportLibTV: () => void;
    onImportTapNow: () => void;
    onUndo: () => void;
    onRedo: () => void;
    mediaPerformanceMode: CanvasMediaPerformanceMode;
    onMediaPerformanceModeChange: (mode: CanvasMediaPerformanceMode) => void;
    onOpenSearch: () => void;
    projectContext?: CanvasContextSummary & { projectId: string; projectName: string };
    onEnterFocusMode: () => void;
    shortDramaGuide?: { progress: CanvasShortDramaProgress; collapsed: boolean; onToggle: () => void };
    localOnly?: boolean;
    libtvChrome?: boolean;
    readOnly?: boolean;
    onDuplicateProject?: () => void | Promise<void>;
    libtvReadonlyChrome?: boolean;
};

export function CanvasTopBar({
    workspaceView,
    onWorkspaceViewChange,
    syncStatus,
    versionsOpen,
    onToggleVersions,
    onOpenWorkflows,
    workflowsOpen = false,
    assistantOpen = false,
    onToggleAssistant,
    title,
    titleDraft,
    isTitleEditing,
    onTitleDraftChange,
    onStartTitleEditing,
    onFinishTitleEditing,
    onCancelTitleEditing,
    canUndo,
    canRedo,
    onCreateCanvas,
    projectCanvases = [],
    currentCanvasId,
    onSwitchCanvas,
    onOpenCanvasInNewWindow,
    onRenameCanvas,
    onDuplicateCanvas,
    onDeleteCanvas,
    onDeleteProject,
    onSave,
    onForceSave,
    onImportImage,
    onUndo,
    onRedo,
    mediaPerformanceMode,
    onMediaPerformanceModeChange,
    onOpenSearch,
    projectContext,
    onEnterFocusMode,
    shortDramaGuide,
    localOnly = false,
    libtvChrome = false,
    readOnly = false,
    onDuplicateProject,
    libtvReadonlyChrome = false,
}: CanvasTopBarProps) {
    const theme = canvasThemes[useCanvasThemeStore((state) => state.theme)];
    const dockStyle = canvasDockStyle(theme, theme.node.text);
    const currentCanvasIndex = Math.max(0, projectCanvases.findIndex((canvas) => canvas.id === currentCanvasId));
    const currentCanvasLabel = projectCanvases[currentCanvasIndex]?.title || `画布 ${currentCanvasIndex + 1}`;
    const titleRef = useRef<HTMLDivElement>(null);
    const renameCanvasInputRef = useRef<HTMLInputElement>(null);
    const [renameCanvas, setRenameCanvas] = useState<{ id: string; title: string } | null>(null);
    const [canvasMenuOpen, setCanvasMenuOpen] = useState(false);
    const [canvasActionMenuId, setCanvasActionMenuId] = useState<string | null>(null);

    const handleShortDramaGuideToggle = () => {
        shortDramaGuide?.onToggle();
    };

    const commitCanvasRename = async () => {
        if (!renameCanvas) return;
        const nextTitle = renameCanvas.title.trim();
        const canvasId = renameCanvas.id;
        setRenameCanvas(null);
        if (nextTitle) await onRenameCanvas?.(canvasId, nextTitle);
    };

    const cancelCanvasRename = () => setRenameCanvas(null);


    useEffect(() => {
        if (!renameCanvas) return;
        const frame = window.requestAnimationFrame(() => {
            renameCanvasInputRef.current?.focus();
            renameCanvasInputRef.current?.select();
        });
        return () => window.cancelAnimationFrame(frame);
    }, [renameCanvas?.id]);

    if (libtvReadonlyChrome) {
        return (
            <div className="canvas-libtv-readonly-bar" data-canvas-no-zoom>
                <div className="canvas-libtv-readonly-title" title={title}>{title === "未命名工作区" ? "BLUE NIGHT蓝色奇妙夜" : title}</div>
                <div className="canvas-libtv-readonly-center" aria-hidden="true">
                    <span className="canvas-libtv-readonly-center-button is-active"><Workflow className="size-4" /></span>
                    <span className="canvas-libtv-readonly-center-button"><Columns2 className="size-4" /></span>
                </div>
                <div className="canvas-libtv-readonly-actions">
                    <span className="canvas-libtv-readonly-hint">只读模式，如需创建请点击</span>
                    <button type="button" className="canvas-libtv-readonly-copy" onClick={() => void onDuplicateProject?.()}>
                        <CopyPlus className="size-4" />复制项目
                    </button>
                    <Link to="/canvas" className="canvas-libtv-readonly-close" aria-label="关闭只读画布"><X className="size-5" /></Link>
                </div>
            </div>
        );
    }

    useEffect(() => {
        if (!isTitleEditing) return;
        const close = (event: PointerEvent) => {
            if (!titleRef.current?.contains(event.target as Node)) onFinishTitleEditing();
        };
        document.addEventListener("pointerdown", close, true);
        return () => document.removeEventListener("pointerdown", close, true);
    }, [isTitleEditing, onFinishTitleEditing]);

    return (
        <>
            <div className="canvas-topbar pointer-events-none absolute inset-x-0 top-0 z-[var(--z-toolbar)] flex h-[var(--canvas-topbar-h)] items-center justify-between px-2 sm:px-2">
                <div className="pointer-events-none flex items-center gap-2">
                <div className="canvas-topbar-cluster canvas-topbar-project-cluster pointer-events-auto flex min-w-0 items-center gap-2" style={dockStyle}>
                    <Dropdown
                            trigger={["click"]}
                            placement="bottomLeft"
                            align={{ offset: [-4, 6] }}
                            overlayClassName="canvas-project-primary-menu"
                            menu={{
                                items: [
                                    { key: "home", label: <Link to="/">回到主页</Link> },
                                    { key: "projects", label: <Link to="/canvas">全部项目</Link> },
                                    { type: "divider" },
                                    { key: "new", label: <Link to="/canvas?mode=new">创建新项目</Link> },
                                    { key: "delete", danger: true, label: "删除当前画布", onClick: onDeleteProject },
                                ],
                            }}
                        >
                            <button type="button" className="canvas-topbar-project-menu-button canvas-topbar-action inline-flex size-9 items-center justify-center gap-0.5 rounded-full" style={{ color: theme.node.text }} aria-label="打开画布菜单">
                                {libtvChrome ? (
                                    <span className="canvas-topbar-libtv-brand-mark" aria-hidden="true" />
                                ) : (
                                    <BrandLogoFrame className="canvas-topbar-brand-mark" logoClassName="canvas-topbar-brand-mark-image" alt="" fallback={<span className="canvas-topbar-brand-mark-fallback" aria-hidden="true">B</span>} />
                                )}
                                <ChevronDown className="size-2.5 opacity-55" aria-hidden="true" />
                            </button>
                    </Dropdown>

                    <div ref={titleRef} className="canvas-topbar-title-block flex min-w-0 flex-auto flex-col items-start overflow-hidden">
                        {isTitleEditing ? (
                            <input
                                autoFocus
                                size={canvasTitleInputSize(titleDraft)}
                                value={titleDraft}
                                onChange={(event) => onTitleDraftChange(event.target.value)}
                                onBlur={onFinishTitleEditing}
                                onKeyDown={(event) => {
                                    if (event.key === "Enter") onFinishTitleEditing();
                                    if (event.key === "Escape") onCancelTitleEditing();
                                }}
                                className="h-8 w-auto min-w-12 max-w-[min(280px,42vw)] appearance-none border-0 bg-transparent p-0 text-left text-base font-semibold tracking-normal outline-none ring-0 focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0"
                                style={{ color: theme.node.text, caretColor: theme.accent.primary, border: 0, boxShadow: "none", outline: "none" }}
                                aria-label="画布名称"
                            />
                        ) : (
                            <div className="canvas-topbar-title-row flex min-w-0 items-center gap-0.5">
                                <button type="button" className="min-w-0 flex-1 truncate text-left text-base font-semibold tracking-normal transition-opacity hover:opacity-75" onClick={onStartTitleEditing} title="点击修改画布名称">
                                    {title}
                                </button>
                                <CanvasTopBarTooltip label="重命名画布">
                                    <button
                                        type="button"
                                        className="canvas-topbar-rename-button canvas-topbar-action grid size-7 shrink-0 place-items-center rounded-md opacity-60 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2"
                                        style={{ color: theme.node.text }}
                                        onClick={onStartTitleEditing}
                                        aria-label="重命名画布"
                                    >
                                        <Pencil className="size-3.5" />
                                    </button>
                                </CanvasTopBarTooltip>
                            </div>
                        )}
                        {projectContext && !isTitleEditing ? (
                            <div className="canvas-topbar-project-context mt-0.5 flex w-full min-w-0 items-center gap-1.5 overflow-hidden text-[var(--fs-tiny)]" style={{ color: theme.node.muted }}>
                                <Link to={`/projects/${projectContext.projectId}/overview`} className="inline-flex min-w-0 items-center gap-1 hover:underline" title={`返回项目：${projectContext.projectName}`}>
                                    <FolderKanban className="size-3 shrink-0" />
                                    <span className="max-w-[120px] truncate">{projectContext.projectName}</span>
                                </Link>
                                <span aria-hidden>·</span>
                                <button type="button" className="min-w-0 truncate hover:underline" onClick={onOpenSearch} title="搜索并定位章节或镜头">
                                    {projectContext.chapterLabel || `${projectContext.nodeCount} 个节点`}
                                    {projectContext.shotLabel ? ` · ${projectContext.shotLabel}` : ""}
                                    {projectContext.selectedCount ? ` · 已选 ${projectContext.selectedCount}` : ""}
                                </button>
                            </div>
                        ) : null}
                    </div>
                    <Dropdown
                        trigger={["click"]}
                        open={canvasMenuOpen}
                        onOpenChange={(open) => {
                            if (!open && canvasActionMenuId) return;
                            setCanvasMenuOpen(open);
                        }}
                        popupRender={() => (
                            <div
                                className="canvas-topbar-canvas-menu-panel"
                                style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
                                onPointerDown={(event) => event.stopPropagation()}
                            >
                                <div className="canvas-topbar-canvas-menu-header">
                                    <span className="canvas-topbar-canvas-menu-heading">画布</span>
                                    <button type="button" className="canvas-topbar-canvas-menu-add" onClick={onCreateCanvas} aria-label="新建画布">
                                        <Plus className="size-6" />
                                    </button>
                                </div>
                                <div className="canvas-topbar-canvas-menu-list">
                                    {projectCanvases.map((canvas, index) => {
                                        const selected = canvas.id === currentCanvasId;
                                        const actionsOpen = canvasActionMenuId === canvas.id;
                                        const canvasLabel = canvas.title || `画布 ${index + 1}`;
                                        return (
                                            <div key={canvas.id} className={`canvas-topbar-canvas-menu-row${selected ? " is-current" : ""}${actionsOpen ? " is-actions-open" : ""}${renameCanvas?.id === canvas.id ? " is-renaming" : ""}`}>
                                                {renameCanvas?.id === canvas.id ? (
                                                    <input
                                                        ref={renameCanvasInputRef}
                                                        className="canvas-topbar-canvas-menu-rename-input"
                                                        value={renameCanvas.title}
                                                        maxLength={60}
                                                        aria-label={`重命名画布：${canvasLabel}`}
                                                        onPointerDown={(event) => event.stopPropagation()}
                                                        onClick={(event) => event.stopPropagation()}
                                                        onChange={(event) => setRenameCanvas((current) => current ? { ...current, title: event.target.value } : current)}
                                                        onBlur={() => void commitCanvasRename()}
                                                        onKeyDown={(event) => {
                                                            if (event.key === "Enter") {
                                                                event.preventDefault();
                                                                void commitCanvasRename();
                                                            }
                                                            if (event.key === "Escape") cancelCanvasRename();
                                                        }}
                                                    />
                                                ) : (
                                                    <button type="button" className="canvas-topbar-canvas-menu-select" onClick={() => onSwitchCanvas?.(canvas.id)} aria-current={selected ? "page" : undefined}>
                                                        <span>{canvasLabel}</span>
                                                    </button>
                                                )}
                                                <span className="canvas-topbar-canvas-menu-end">
                                                    {selected ? <Check className="canvas-topbar-canvas-menu-check size-5" aria-label="当前画布" /> : null}
                                                    <Dropdown
                                                        trigger={["hover", "click"]}
                                                        placement="bottomLeft"
                                                        onOpenChange={(open) => {
                                                            setCanvasActionMenuId(open ? canvas.id : null);
                                                            if (open) setCanvasMenuOpen(true);
                                                        }}
                                                        menu={{
                                                            items: [
                                                                { key: "new-window", label: "在新窗口打开", onClick: () => onOpenCanvasInNewWindow?.(canvas.id) },
                                                                { key: "rename", label: "重命名画布", onClick: () => { setCanvasMenuOpen(true); setRenameCanvas({ id: canvas.id, title: canvasLabel }); } },
                                                                { key: "duplicate", label: "复制画布", onClick: () => void onDuplicateCanvas?.(canvas.id) },
                                                                { key: "delete", danger: true, label: "删除画布", onClick: () => void onDeleteCanvas?.(canvas.id) },
                                                            ],
                                                        }}
                                                    >
                                                        <button type="button" className="canvas-topbar-canvas-menu-more" aria-label={`画布操作：${canvasLabel}`} onClick={(event) => event.stopPropagation()}>
                                                            <MoreHorizontal className="size-5" />
                                                        </button>
                                                    </Dropdown>
                                                </span>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        )}
                    >
                        <button type="button" className="canvas-topbar-canvas-switch canvas-topbar-action inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 text-xs opacity-75 hover:opacity-100" style={{ color: theme.node.text }} aria-label="切换画布">
                            <span>{currentCanvasLabel}</span>{canvasMenuOpen ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
                        </button>
                    </Dropdown>
                    <span className="canvas-topbar-sync-status">{syncStatus}</span>
                </div>
                </div>

                {readOnly ? (
                    <div className="canvas-topbar-readonly-banner pointer-events-auto absolute right-6 flex items-center gap-3 rounded-lg px-2 text-xs" role="status">
                        <span>只读模式，如需创建请点击</span>
                        {onDuplicateProject ? (
                            <Button type="primary" size="small" icon={<CopyPlus className="size-3.5" />} onClick={() => void onDuplicateProject()} aria-label="复制项目">
                                复制项目
                            </Button>
                        ) : null}
                    </div>
                ) : null}

                <div className="canvas-topbar-cluster canvas-topbar-local-cluster pointer-events-auto hidden items-center gap-1 lg:flex" style={dockStyle}>
                    {onOpenWorkflows ? <Button type="text" className="canvas-topbar-action canvas-topbar-workflow-button !h-9 !rounded-xl !px-2.5" style={{ color: theme.node.text, background: workflowsOpen ? theme.toolbar.activeBg : undefined }} aria-pressed={workflowsOpen} icon={<Workflow className="size-4" />} onClick={onOpenWorkflows}>工作流</Button> : null}
                    {onToggleAssistant ? (
                        <CanvasTopBarTooltip label="Agent（Ctrl/Cmd + J）">
                            <Button
                                type="text"
                                className="canvas-topbar-action canvas-topbar-agent-button !h-9 !rounded-xl !px-2.5 !font-medium"
                                style={{ color: theme.node.text, background: assistantOpen ? theme.toolbar.activeBg : undefined }}
                                icon={<Sparkles className="size-4" />}
                                onClick={onToggleAssistant}
                                aria-label="Agent"
                                aria-pressed={assistantOpen}
                            >
                                Agent
                            </Button>
                        </CanvasTopBarTooltip>
                    ) : null}
                    {!libtvChrome ? <CanvasTopBarTooltip label="版本记录"><Button type="text" className="canvas-topbar-action !h-9 !w-9 !min-w-9 !rounded-xl !p-0" style={{ color: theme.node.text, background: versionsOpen ? theme.toolbar.activeBg : undefined }} icon={<History className="size-4" />} onClick={onToggleVersions} aria-label="版本记录" aria-pressed={versionsOpen} /></CanvasTopBarTooltip> : null}
                </div>

                <div className="canvas-topbar-cluster canvas-topbar-tools-cluster pointer-events-auto flex items-center gap-1.5 lg:hidden" style={dockStyle}>
                    {onOpenWorkflows ? <CanvasTopBarTooltip label="工作流"><Button type="text" className="canvas-topbar-action canvas-topbar-workflow-button !h-10 !w-10 !min-w-10 !rounded-xl !p-0" style={{ color: theme.node.text, background: workflowsOpen ? theme.toolbar.activeBg : undefined }} aria-pressed={workflowsOpen} icon={<Workflow className="size-4" />} aria-label="工作流" onClick={onOpenWorkflows} /></CanvasTopBarTooltip> : null}
                    <CanvasTopBarTooltip label="搜索画布节点">
                        <Button
                            type="text"
                            className="canvas-topbar-action !hidden !h-10 !w-10 !min-w-10 !rounded-xl !p-0 lg:!inline-flex"
                            style={{ color: theme.node.text }}
                            icon={<Search className="size-4" />}
                            onClick={onOpenSearch}
                            aria-label="搜索画布节点"
                        />
                    </CanvasTopBarTooltip>
                    <CanvasTopBarTooltip label="媒体性能模式">
                        <Dropdown
                            trigger={["click"]}
                            menu={{
                                selectable: true,
                                selectedKeys: [mediaPerformanceMode],
                                onClick: ({ key }) => onMediaPerformanceModeChange(key as CanvasMediaPerformanceMode),
                                items: [
                                    { key: "auto", label: "自动性能" },
                                    { key: "quality", label: "画质优先" },
                                    { key: "performance", label: "性能优先" },
                                ],
                            }}
                        >
                            <Button type="text" className="canvas-topbar-action !hidden !h-10 !w-10 !min-w-10 !rounded-xl !p-0 lg:!inline-flex" style={{ color: theme.node.text }} icon={<Gauge className="size-4" />} aria-label="媒体性能模式" />
                        </Dropdown>
                    </CanvasTopBarTooltip>
                    <CanvasTopBarTooltip label="进入专注模式（Shift + Ctrl/Cmd + F）">
                        <Button type="text" className="canvas-topbar-action !h-10 !w-10 !min-w-10 !rounded-xl !p-0" style={{ color: theme.node.text }} icon={<Focus className="size-4" />} onClick={onEnterFocusMode} aria-label="进入专注模式" />
                    </CanvasTopBarTooltip>
                    {shortDramaGuide ? (
                        <CanvasTopBarTooltip label={shortDramaGuide.collapsed ? "展开短剧流程" : "收起短剧流程"}>
                            <Button
                                type="text"
                                className="canvas-topbar-action !h-10 !rounded-xl !px-2.5 !font-medium"
                                style={{ color: theme.node.text, background: shortDramaGuide.collapsed ? undefined : theme.toolbar.activeBg }}
                                icon={<Clapperboard className="size-4" />}
                                onClick={handleShortDramaGuideToggle}
                                aria-label="短剧流程"
                                aria-pressed={!shortDramaGuide.collapsed}
                            >
                                <span className="tabular-nums">{shortDramaGuide.progress.completedCount}/5</span>
                            </Button>
                        </CanvasTopBarTooltip>
                    ) : null}
                    {onToggleAssistant ? (
                        <CanvasTopBarTooltip label="Agent（Ctrl/Cmd + J）">
                            <Button
                                type="text"
                                className="canvas-topbar-action canvas-topbar-agent-button !h-10 !rounded-xl !px-2.5 !font-medium"
                                style={{ color: theme.node.text, background: assistantOpen ? theme.toolbar.activeBg : undefined }}
                                icon={<Sparkles className="size-4" />}
                                onClick={onToggleAssistant}
                                aria-label="Agent"
                                aria-pressed={assistantOpen}
                            >
                                <span className="sr-only">Agent</span>
                            </Button>
                        </CanvasTopBarTooltip>
                    ) : null}
                    <CanvasTopBarTooltip label="版本记录">
                        <Button
                            type="text"
                            className="canvas-topbar-action canvas-topbar-version-button !h-10 !rounded-xl !px-2.5 !font-medium"
                            style={{ color: theme.node.text, background: versionsOpen ? theme.toolbar.activeBg : undefined }}
                            icon={<History className="size-4" />}
                            aria-label="版本记录"
                            aria-pressed={versionsOpen}
                            onClick={onToggleVersions}
                        >
                            <span className="sr-only">版本</span>
                        </Button>
                    </CanvasTopBarTooltip>
                </div>
            </div>
        </>
    );
}

// 顶栏是 --z-toolbar 上的绝对定位浮层，会为子元素建立层叠上下文。行内绝对定位的提示
// 无论 z-index 多高都无法越过它，会被顶栏下方 --z-panel-floating 的生成任务面板盖住，
// 因此提示必须走 portal 的浮层层级。
function CanvasTopBarTooltip({ label, children }: { label: string; children: ReactNode }) {
    return (
        <Tooltip title={label} placement="bottom">
            <span className="relative inline-flex shrink-0">{children}</span>
        </Tooltip>
    );
}

function MenuLabel({ text, shortcut }: { text: string; shortcut: string }) {
    return (
        <span className="flex min-w-36 items-center justify-between gap-8">
            <span>{text}</span>
            <span className="text-xs opacity-45">{shortcut}</span>
        </span>
    );
}

function canvasTitleInputSize(value: string) {
    const visualLength = Array.from(value || "画布名称").reduce((length, character) => length + (character.codePointAt(0)! > 0xff ? 2 : 1), 0);
    return Math.min(30, Math.max(5, visualLength));
}
