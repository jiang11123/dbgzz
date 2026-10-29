import { motion, useReducedMotion } from "motion/react";
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { useMemo } from "react";
import { Image as ImageIcon, MessageSquareText, Video } from "lucide-react";

import { CanvasCreateMenu, type CanvasCreateCommand } from "@/components/canvas/canvas-create-menu";
import { useCanvasOverlayLayer } from "@/components/canvas/canvas-overlay-layer";
import { canvasThemes } from "@/lib/canvas-theme";
import { aceternityMotion } from "@/lib/aceternity-motion";
import { subscribeCanvasGraphicsViewportPreview, subscribeCanvasNodeDragPreview, subscribeCanvasViewportPreview } from "@/lib/canvas/canvas-live-viewport";
import { getNodeIcon } from "@/lib/canvas/node-registry";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";
import { CanvasNodeType, type CanvasNodeData, type ConnectionHandle, type DoubaoNodeTaskMode, type Position, type ViewportTransform } from "@/types/canvas";
import { useDoubaoPreferencesStore } from "@/stores/use-doubao-preferences-store";

export type PendingConnectionCreate = {
    connection: ConnectionHandle;
    position: Position;
    quick?: boolean;
    batchSourceNodeIds?: string[];
};

export function CanvasSelectionToolbar({ anchorRef, containerRef, count, children }: { anchorRef: RefObject<HTMLDivElement | null>; containerRef: RefObject<HTMLDivElement | null>; count: number; children: ReactNode }) {
    const theme = canvasThemes[useActiveTheme()];
    const reducedMotion = useReducedMotion();
    const toolbarRef = useRef<HTMLDivElement>(null);
    const [anchor, setAnchor] = useState<{ left: number; top: number; placement: "above" | "below" } | null>(null);

    useLayoutEffect(() => {
        const element = anchorRef.current;
        const container = containerRef.current;
        if (!element || !container) {
            setAnchor(null);
            return;
        }

        const update = () => {
            const bounds = element.getBoundingClientRect();
            const containerBounds = container.getBoundingClientRect();
            const toolbarWidth = toolbarRef.current?.offsetWidth || 320;
            const toolbarHeight = toolbarRef.current?.offsetHeight || 38;
            const halfWidth = Math.min(toolbarWidth / 2, Math.max(0, containerBounds.width / 2 - 12));
            const center = bounds.left - containerBounds.left + bounds.width / 2;
            const left = Math.min(Math.max(center, 12 + halfWidth), Math.max(12 + halfWidth, containerBounds.width - 12 - halfWidth));
            const boundsTop = bounds.top - containerBounds.top;
            const boundsBottom = bounds.bottom - containerBounds.top;
            const placement = boundsTop - toolbarHeight - 8 >= 68 ? "above" : "below";
            const top = placement === "above" ? boundsTop - 8 : Math.min(boundsBottom + 8, containerBounds.height - toolbarHeight - 12);
            if (toolbarRef.current) {
                toolbarRef.current.style.left = `${left}px`;
                toolbarRef.current.style.top = `${top}px`;
                toolbarRef.current.classList.toggle("-translate-y-full", placement === "above");
                return;
            }
            setAnchor((current) => current?.left === left && current.top === top && current.placement === placement ? current : { left, top, placement });
        };

        update();
        const resizeObserver = new ResizeObserver(update);
        resizeObserver.observe(element);
        resizeObserver.observe(container);
        if (toolbarRef.current) resizeObserver.observe(toolbarRef.current);
        const viewportLayer = element.parentElement;
        const mutationObserver = new MutationObserver(update);
        if (viewportLayer) mutationObserver.observe(viewportLayer, { attributes: true, attributeFilter: ["style"] });
        const unsubscribeViewport = subscribeCanvasViewportPreview(container, update);
        window.addEventListener("resize", update);
        return () => {
            resizeObserver.disconnect();
            mutationObserver.disconnect();
            unsubscribeViewport();
            window.removeEventListener("resize", update);
        };
    }, [anchorRef, containerRef, count]);

    if (!anchor) return null;
    return (
        <div
            ref={toolbarRef}
            data-canvas-no-zoom
            className={`absolute z-[var(--z-panel-floating)] max-w-[calc(100%_-_24px)] -translate-x-1/2 ${anchor.placement === "above" ? "-translate-y-full" : ""}`}
            style={{ left: anchor.left, top: anchor.top, color: theme.node.text, transformOrigin: anchor.placement === "above" ? "bottom center" : "top center" }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
        >
            <motion.div initial={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.9, y: anchor.placement === "above" ? 8 : -8 }} animate={{ opacity: 1, scale: 1, y: 0 }} transition={aceternityMotion.spring.panel} className="flex items-center gap-2">
                <span className="aceternity-floating-panel shrink-0 rounded-full border px-2.5 py-1.5 text-[var(--fs-tiny)] font-semibold tabular-nums backdrop-blur-2xl" style={{ background: theme.spatial.elevated, borderColor: theme.toolbar.border, color: theme.accent.primary }}>已选 {count}</span>
                <div className="max-w-[min(560px,calc(100vw-90px))]">{children}</div>
            </motion.div>
        </div>
    );
}

export const CANVAS_MAIN_DOCK_CLEARANCE = 80;

export function CanvasNodePanelOverlay({ node, viewport, containerRef, panelWidth, panelMinWidth = 660, panelMaxWidth = 920, panelWidthScale = 1.5, panelHeight = 190, dragOffset, isDragging = false, allowOverflow = false, keepBelowNode = false, avoidBottomDock = false, className, children }: { node: CanvasNodeData; viewport: ViewportTransform; containerRef: RefObject<HTMLDivElement | null>; panelWidth?: number; panelMinWidth?: number; panelMaxWidth?: number; panelWidthScale?: number; panelHeight?: number; dragOffset?: Position | null; isDragging?: boolean; allowOverflow?: boolean; keepBelowNode?: boolean; avoidBottomDock?: boolean; className?: string; children: ReactNode }) {
    const panelRef = useRef<HTMLDivElement>(null);
    const { bringToFront, zIndex } = useCanvasOverlayLayer(`node-panel:${node.id}`, "var(--z-modal-overlay)");
    const initialWidth = resolveNodePanelWidth(node, viewport, panelWidth, panelMinWidth, panelMaxWidth, panelWidthScale);
    const initialPosition = getNodePanelPosition(node, viewport, { width: containerRef.current?.clientWidth || 0, height: containerRef.current?.clientHeight || 0 }, initialWidth, panelHeight, dragOffset, keepBelowNode, avoidBottomDock);

    useLayoutEffect(() => {
        bringToFront();
    }, [bringToFront]);

    useLayoutEffect(() => {
        const container = containerRef.current;
        const panel = panelRef.current;
        if (!container || !panel) return;
        let liveViewport = viewport;
        let liveDragOffset = dragOffset;
        let viewportSize = { width: container.clientWidth, height: container.clientHeight };
        const update = (nextViewport: ViewportTransform) => {
            liveViewport = nextViewport;
            const nextWidth = resolveNodePanelWidth(node, nextViewport, panelWidth, panelMinWidth, panelMaxWidth, panelWidthScale);
            panel.style.width = `${nextWidth}px`;
            const nodeElement = container.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(node.id)}"]`);
            const position = nodeElement
                ? getAttachedNodePanelPosition(nodeElement, container, nextWidth, panelHeight, keepBelowNode, avoidBottomDock)
                : getNodePanelPosition(node, nextViewport, viewportSize, nextWidth, panelHeight, liveDragOffset, keepBelowNode, avoidBottomDock);
            panel.style.transform = `translate3d(${position.left}px, ${position.top}px, 0)`;
        };
        update(viewport);
        const resizeObserver = new ResizeObserver(() => {
            viewportSize = { width: container.clientWidth, height: container.clientHeight };
            update(liveViewport);
        });
        resizeObserver.observe(container);
        const unsubscribeViewport = subscribeCanvasGraphicsViewportPreview(container, update);
        const unsubscribeDrag = subscribeCanvasNodeDragPreview(container, (preview) => {
            liveDragOffset = preview?.nodeIds.has(node.id) ? { x: preview.x, y: preview.y } : null;
            update(liveViewport);
        });
        return () => {
            resizeObserver.disconnect();
            unsubscribeViewport();
            unsubscribeDrag();
        };
    }, [avoidBottomDock, containerRef, dragOffset?.x, dragOffset?.y, isDragging, keepBelowNode, node.height, node.id, node.position.x, node.position.y, node.width, panelHeight, panelMaxWidth, panelMinWidth, panelWidth, panelWidthScale, viewport]);

    return (
        <div
            ref={panelRef}
            data-canvas-no-zoom
            data-canvas-node-panel
            className={`thin-scrollbar absolute max-w-[calc(100%_-_24px)] ${allowOverflow ? "overflow-visible" : "overflow-y-auto"}${className ? ` ${className}` : ""}`}
            style={{ left: 0, top: 0, transform: `translate3d(${initialPosition.left}px, ${initialPosition.top}px, 0)`, width: initialWidth, maxHeight: allowOverflow ? "none" : "calc(100% - 84px)", zIndex }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDownCapture={bringToFront}
            onFocusCapture={bringToFront}
            onPointerDown={(event) => event.stopPropagation()}
        >
            {children}
        </div>
    );
}

function resolveNodePanelWidth(node: CanvasNodeData, viewport: ViewportTransform, requestedWidth?: number, minWidth = 660, maxWidth = 920, widthScale = 1.5) {
    if (requestedWidth) return requestedWidth;
    return clamp(Math.round(node.width * viewport.k * widthScale), minWidth, maxWidth);
}

export function CanvasConnectionCreateMenu({
    pending,
    viewport,
    viewportSize,
    containerRef,
    canCreateDrawing,
    getDisabledReason,
    onCreate,
    onClose,
}: {
    pending: PendingConnectionCreate;
    viewport: ViewportTransform;
    viewportSize: { width: number; height: number };
    containerRef: RefObject<HTMLDivElement | null>;
    canCreateDrawing: boolean;
    getDisabledReason: (
        type: CanvasNodeType.Image | CanvasNodeType.Text | CanvasNodeType.Script | CanvasNodeType.BatchTable | CanvasNodeType.Video | CanvasNodeType.Audio | CanvasNodeType.Drawing | CanvasNodeType.Config | CanvasNodeType.MediaConversion | CanvasNodeType.DoubaoAccount,
        provider?: "runninghub",
        doubaoMode?: DoubaoNodeTaskMode,
    ) => string;
    onCreate: (
        type: CanvasNodeType.Image | CanvasNodeType.Text | CanvasNodeType.Script | CanvasNodeType.BatchTable | CanvasNodeType.Video | CanvasNodeType.Audio | CanvasNodeType.Drawing | CanvasNodeType.Config | CanvasNodeType.MediaConversion | CanvasNodeType.DoubaoAccount,
        provider?: "runninghub",
        doubaoMode?: DoubaoNodeTaskMode,
    ) => void;
    onClose: () => void;
}) {
    const theme = canvasThemes[useActiveTheme()];
    const menuRef = useRef<HTMLDivElement>(null);
    const showDoubaoNodes = useDoubaoPreferencesStore((state) => state.showDoubaoNodes);
    const { bringToFront, zIndex } = useCanvasOverlayLayer("connection-create-menu", "var(--z-modal-overlay)");
    const menuWidth = Math.min(216, viewportSize.width - 24);
    const menuHeight = 460;
    const gap = 12;
    const initialPosition = getConnectionMenuPosition(pending.position, viewport, viewportSize, menuWidth, menuHeight, gap);
    const commands = useMemo<CanvasCreateCommand[]>(() => {
        type CreatableNodeType = Parameters<typeof onCreate>[0];
        const create = (type: CreatableNodeType, provider?: "runninghub", doubaoMode?: DoubaoNodeTaskMode) => () => { onCreate(type, provider, doubaoMode); onClose(); };
        const command = (id: string, label: string, type: CreatableNodeType, icon: ReactNode, section: CanvasCreateCommand["section"] = "node", disabledReason?: string, action?: () => void): CanvasCreateCommand => ({ id, label, icon, section, disabledReason, onClick: action || create(type) });
        return [
            command("text", "文本", CanvasNodeType.Text, getNodeIcon(CanvasNodeType.Text), "node", getDisabledReason(CanvasNodeType.Text)),
            command("image", "图片", CanvasNodeType.Image, getNodeIcon(CanvasNodeType.Image), "node", getDisabledReason(CanvasNodeType.Image)),
            command("video", "视频", CanvasNodeType.Video, getNodeIcon(CanvasNodeType.Video), "node", getDisabledReason(CanvasNodeType.Video)),
            command("doubao-text", "豆包文字", CanvasNodeType.DoubaoAccount, <MessageSquareText className="size-4" />, "node", getDisabledReason(CanvasNodeType.DoubaoAccount, undefined, "chat"), create(CanvasNodeType.DoubaoAccount, undefined, "chat")),
            command("doubao-image", "豆包图片", CanvasNodeType.DoubaoAccount, <ImageIcon className="size-4" />, "node", getDisabledReason(CanvasNodeType.DoubaoAccount, undefined, "image"), create(CanvasNodeType.DoubaoAccount, undefined, "image")),
            command("doubao-video", "豆包视频", CanvasNodeType.DoubaoAccount, <Video className="size-4" />, "node", getDisabledReason(CanvasNodeType.DoubaoAccount, undefined, "video"), create(CanvasNodeType.DoubaoAccount, undefined, "video")),
            command("audio", "音频", CanvasNodeType.Audio, getNodeIcon(CanvasNodeType.Audio), "node", getDisabledReason(CanvasNodeType.Audio)),
            command("smart-edit", "智能剪辑", CanvasNodeType.MediaConversion, getNodeIcon(CanvasNodeType.MediaConversion), "node", "暂不可用"),
            command("director", "导演台", CanvasNodeType.Config, getNodeIcon(CanvasNodeType.Config), "node", "暂不可用"),
            command("script", "脚本", CanvasNodeType.Script, getNodeIcon(CanvasNodeType.Script), "node", "暂不可用"),
        ].filter((command) => showDoubaoNodes || !command.id.startsWith("doubao-"));
    }, [getDisabledReason, onClose, onCreate, showDoubaoNodes]);

    useLayoutEffect(() => {
        bringToFront();
    }, [bringToFront]);

    useLayoutEffect(() => {
        const container = containerRef.current;
        const menu = menuRef.current;
        if (!container || !menu) return;
        const update = (nextViewport: ViewportTransform) => {
            const containerBounds = container.getBoundingClientRect();
            const safeWidth = containerBounds.width;
            const position = getConnectionMenuPosition(pending.position, nextViewport, { width: safeWidth, height: containerBounds.height }, menu.offsetWidth || menuWidth, menu.offsetHeight || menuHeight, gap);
            menu.style.left = `${position.left}px`;
            menu.style.top = `${position.top}px`;
        };
        update(viewport);
        return subscribeCanvasViewportPreview(container, update);
    }, [containerRef, pending.position, viewport, viewportSize.height, viewportSize.width]);

    return (
        <motion.div
            ref={menuRef}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: aceternityMotion.duration.instant, ease: aceternityMotion.easing.enter }}
            className="thin-scrollbar absolute origin-top-left overflow-x-hidden overflow-y-auto rounded-[var(--r-2xl)] border p-2"
            data-canvas-no-zoom
            data-connection-create-menu
            aria-label="创建下一步"
            onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}
            style={{ width: menuWidth, maxHeight: Math.max(120, viewportSize.height - 84), left: initialPosition.left, top: initialPosition.top, zIndex, background: theme.spatial.elevated, borderColor: theme.toolbar.border, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDownCapture={bringToFront}
            onFocusCapture={bringToFront}
            onPointerDown={(event) => event.stopPropagation()}
        >
            <CanvasCreateMenu commands={commands} layout="list" title="引用该节点生成" showSearch={false} showSectionTitles={false} showResources={false} />
        </motion.div>
    );
}

function clamp(value: number, min: number, max: number) {
    return Math.min(Math.max(value, min), max);
}

function getConnectionMenuPosition(position: Position, viewport: ViewportTransform, viewportSize: { width: number; height: number }, menuWidth: number, menuHeight: number, gap: number) {
    const screenX = viewport.x + position.x * viewport.k;
    const screenY = viewport.y + position.y * viewport.k;
    return {
        left: clamp(screenX, gap, Math.max(gap, viewportSize.width - menuWidth - gap)),
        top: clamp(screenY, 72, Math.max(72, viewportSize.height - menuHeight - gap)),
    };
}

function constrainNodePanelPosition(left: number, top: number, viewportSize: { width: number; height: number }, panelWidth: number, panelHeight: number, preferredTop: number, keepBelowNode = false, avoidBottomDock = false) {
    const gap = 16;
    // Keep the compact composer below the node on short viewports; LibTV
    // reserves only a small gap above the bottom controls.
    const bottomReserve = avoidBottomDock ? CANVAS_MAIN_DOCK_CLEARANCE : 16;
    const maxLeft = Math.max(gap, viewportSize.width - panelWidth - gap);
    const maxTop = Math.max(gap, viewportSize.height - panelHeight - bottomReserve);
    return {
        left: clamp(left, gap, maxLeft),
        top: keepBelowNode
            ? (avoidBottomDock ? Math.min(top, maxTop) : top)
            : clamp(top > maxTop ? Math.max(gap, preferredTop - panelHeight - gap) : top, gap, maxTop),
    };
}

function getAttachedNodePanelPosition(nodeElement: HTMLElement, container: HTMLElement, panelWidth: number, panelHeight: number, keepBelowNode = false, avoidBottomDock = false) {
    const gap = 16;
    const nodeRect = nodeElement.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const viewportSize = { width: container.clientWidth, height: container.clientHeight };
    const left = nodeRect.left - containerRect.left + nodeRect.width / 2 - panelWidth / 2;
    const preferredTop = nodeRect.top - containerRect.top;
    const top = nodeRect.bottom - containerRect.top + gap;
    return {
        ...constrainNodePanelPosition(left, top, viewportSize, panelWidth, panelHeight, preferredTop, keepBelowNode, avoidBottomDock),
        placement: "below" as const,
    };
}

export function getNodePanelPosition(node: CanvasNodeData, viewport: ViewportTransform, viewportSize: { width: number; height: number }, panelWidth: number, panelHeight: number, dragOffset?: Position | null, keepBelowNode = false, avoidBottomDock = false) {
    const gap = 16;
    const offsetX = dragOffset?.x || 0;
    const offsetY = dragOffset?.y || 0;
    const nodeCenterX = viewport.x + (node.position.x + offsetX + node.width / 2) * viewport.k;
    const nodeTop = viewport.y + (node.position.y + offsetY) * viewport.k;
    const nodeBottom = viewport.y + (node.position.y + offsetY + node.height) * viewport.k;
    return {
        ...constrainNodePanelPosition(nodeCenterX - panelWidth / 2, nodeBottom + gap, viewportSize, panelWidth, panelHeight, nodeTop, keepBelowNode, avoidBottomDock),
        placement: "below" as const,
    };
}
