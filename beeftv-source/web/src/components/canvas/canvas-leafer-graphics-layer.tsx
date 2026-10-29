import { useLayoutEffect, useRef, type RefObject } from "react";
import { Group, Leafer, Path, Rect } from "leafer-ui";

import { activeConnectionPath } from "@/components/canvas/canvas-connections";
import type { CanvasBatchConnectionPreview } from "@/lib/canvas/canvas-batch-connection";
import { subscribeCanvasGraphicsViewportPreview, subscribeCanvasNodeDragPreview, subscribeCanvasSelectionPreview, type CanvasNodeDragPreview } from "@/lib/canvas/canvas-live-viewport";
import { calculateCanvasPreviewTransform, sameCanvasViewport, shouldRebaseCanvasRaster } from "@/lib/canvas/canvas-leafer-viewport";
import { offsetSelectedNodeBounds } from "@/lib/canvas/canvas-selection";
import type { CanvasTheme } from "@/lib/canvas-theme";
import type { CanvasNodeData, ConnectionHandle, Position, SelectionBox, ViewportTransform } from "@/types/canvas";

type NodeBounds = { left: number; top: number; width: number; height: number; count: number } | null;

type CanvasLeaferGraphicsLayerProps = {
    containerRef: RefObject<HTMLDivElement | null>;
    viewport: ViewportTransform;
    theme: CanvasTheme;
    scriptScrollTopById: Record<string, number>;
    connectingParams: ConnectionHandle | null;
    batchConnectionPreview: CanvasBatchConnectionPreview | null;
    mouseWorld: Position;
    connectionTargetNodeId: string | null;
    connectionTargetAnchorRatio?: number;
    nodeById: Map<string, CanvasNodeData>;
    selectionBox: SelectionBox | null;
    selectedNodeBounds: NodeBounds;
    alignmentGuides: { vertical?: number; horizontal?: number };
};

type LeaferScene = {
    leafer: Leafer;
    world: Group;
    host: HTMLDivElement;
};

type OverlayScene = LeaferScene & {
    selection: Rect;
    selectionBounds: Rect;
    guides: Path;
    draft: Path;
    batchDrafts: Group;
    dragPreview: CanvasNodeDragPreview | null;
};

export function CanvasLeaferGraphicsLayer(props: CanvasLeaferGraphicsLayerProps) {
    const overlayHostRef = useRef<HTMLDivElement>(null);
    const overlayRef = useRef<OverlayScene | null>(null);
    const viewportRef = useRef(props.viewport);
    const rasterViewportRef = useRef(props.viewport);
    const propsRef = useRef(props);
    propsRef.current = props;

    useLayoutEffect(() => {
        const overlayHost = overlayHostRef.current;
        const container = (props.containerRef.current || overlayHost?.parentElement) as HTMLDivElement | null;
        if (!overlayHost || !container) return;

        const overlay = createOverlayScene(overlayHost);
        overlayRef.current = overlay;

        const resize = () => {
            const rect = container.getBoundingClientRect();
            const size = { width: Math.max(1, rect.width), height: Math.max(1, rect.height), pixelRatio: canvasPixelRatio() };
            overlay.leafer.resize(size);
            syncViewport(rasterViewportRef.current, size.width, size.height, overlay, propsRef.current);
            if (isViewportPreview(container, viewportRef.current, rasterViewportRef.current)) {
                applyScenePreview(viewportRef.current, rasterViewportRef.current, overlay);
            }
        };
        const resizeObserver = new ResizeObserver(resize);
        resizeObserver.observe(container);
        window.addEventListener("resize", resize);
        const unsubscribe = subscribeCanvasGraphicsViewportPreview(container, (next) => {
            viewportRef.current = next;
            const rect = container.getBoundingClientRect();
            if (isViewportPreview(container, next, rasterViewportRef.current)) {
                if (shouldRebaseCanvasRaster(next, rasterViewportRef.current)) {
                    syncViewport(next, rect.width, rect.height, overlay, propsRef.current);
                    rasterViewportRef.current = next;
                    forceSceneRender(overlay);
                    resetScenePreview(overlay);
                    return;
                }
                applyScenePreview(next, rasterViewportRef.current, overlay);
                return;
            }
            resetScenePreview(overlay);
            if (sameCanvasViewport(next, rasterViewportRef.current)) return;
            syncViewport(next, rect.width, rect.height, overlay, propsRef.current);
            rasterViewportRef.current = next;
        });
        const unsubscribeSelection = subscribeCanvasSelectionPreview(container, (selection) => {
            syncSelection(overlay.selection, selection, propsRef.current.theme);
        });
        const unsubscribeNodeDrag = subscribeCanvasNodeDragPreview(container, (preview) => {
            overlay.dragPreview = preview;
            syncLiveSelectionBounds(overlay, propsRef.current, viewportRef.current.k);
        });
        resize();

        return () => {
            unsubscribe();
            unsubscribeSelection();
            unsubscribeNodeDrag();
            resizeObserver.disconnect();
            window.removeEventListener("resize", resize);
            overlay.leafer.destroy(true);
            overlayRef.current = null;
        };
    }, [props.containerRef]);

    useLayoutEffect(() => {
        const overlay = overlayRef.current;
        if (!overlay) return;
        syncOverlayContent(overlay, props, viewportRef.current.k);
    }, [props.batchConnectionPreview, props.connectingParams, props.connectionTargetAnchorRatio, props.connectionTargetNodeId, props.mouseWorld, props.nodeById, props.scriptScrollTopById, props.selectedNodeBounds, props.selectionBox, props.theme]);

    useLayoutEffect(() => {
        const overlay = overlayRef.current;
        const container = props.containerRef.current;
        if (!overlay || !container) return;
        viewportRef.current = props.viewport;
        const rect = container.getBoundingClientRect();
        const hadPreview = hasScenePreview(overlay);
        if (hadPreview || !sameCanvasViewport(props.viewport, rasterViewportRef.current)) {
            syncViewport(props.viewport, rect.width, rect.height, overlay, props);
        }
        rasterViewportRef.current = props.viewport;
        // 新视口先同步到真实 DPR backing store，再撤销交互期的合成变换，避免出现跳帧。
        if (hadPreview) forceSceneRender(overlay);
        resetScenePreview(overlay);
    }, [props.containerRef, props.viewport]);

    useLayoutEffect(() => {
        const overlay = overlayRef.current;
        const container = props.containerRef.current;
        if (!overlay || !container) return;
        const rect = container.getBoundingClientRect();
        syncViewport(rasterViewportRef.current, rect.width, rect.height, overlay, props);
        if (isViewportPreview(container, viewportRef.current, rasterViewportRef.current)) {
            applyScenePreview(viewportRef.current, rasterViewportRef.current, overlay);
        }
    }, [props.alignmentGuides, props.containerRef, props.theme]);

    return (
        <>
            <div ref={overlayHostRef} data-canvas-leafer-overlay className="pointer-events-none absolute inset-0 z-[var(--z-canvas-overlay)] overflow-hidden" aria-hidden />
        </>
    );
}

function createOverlayScene(host: HTMLDivElement): OverlayScene {
    const leafer = new Leafer({ view: host, width: 1, height: 1, pixelRatio: canvasPixelRatio(), fill: "transparent", hittable: false, smooth: true });
    const world = new Group({ hittable: false });
    const selection = new Rect({ visible: false, hittable: false });
    const selectionBounds = new Rect({ visible: false, hittable: false, fill: "transparent" });
    const guides = new Path({ visible: false, hittable: false });
    const draft = new Path({ visible: false, hittable: false });
    const batchDrafts = new Group({ visible: false, hittable: false });
    world.add(selection);
    world.add(selectionBounds);
    world.add(guides);
    world.add(draft);
    world.add(batchDrafts);
    leafer.add(world);
    return { leafer, world, host, selection, selectionBounds, guides, draft, batchDrafts, dragPreview: null };
}

function syncOverlayContent(scene: OverlayScene, props: CanvasLeaferGraphicsLayerProps, viewportScale: number) {
    const selection = props.selectionBox;
    scene.selection.visible = Boolean(selection);
    if (selection) {
        syncSelection(scene.selection, selection, props.theme);
    }

    const bounds = props.selectedNodeBounds;
    scene.selectionBounds.visible = Boolean(bounds && !selection && !scene.dragPreview?.compact);
    if (bounds && !selection) {
        syncSelectionBounds(scene.selectionBounds, liveSelectedNodeBounds(bounds, scene.dragPreview), viewportScale);
        scene.selectionBounds.stroke = props.theme.node.label;
    }

    const connecting = props.connectingParams;
    scene.draft.visible = Boolean(connecting);
    if (connecting) {
        scene.draft.set({
            path: activeConnectionPath(
                props.nodeById.get(connecting.nodeId),
                connecting,
                props.mouseWorld,
                props.connectionTargetNodeId ? props.nodeById.get(props.connectionTargetNodeId) : undefined,
                props.scriptScrollTopById[connecting.nodeId] || 0,
            ),
            stroke: props.theme.accent.primary,
            strokeCap: "round",
            opacity: 0.72,
        });
    }

    scene.batchDrafts.removeAll(true);
    const batch = props.batchConnectionPreview;
    scene.batchDrafts.visible = Boolean(batch);
    if (!batch) return;
    const target = batch.targetNodeId ? props.nodeById.get(batch.targetNodeId) : undefined;
    const stroke = batch.status === "invalid" ? props.theme.accent.danger : batch.status === "partial" ? props.theme.node.activeStroke : props.theme.accent.primary;
    batch.sourceNodeIds.forEach((sourceNodeId) => {
        const source = props.nodeById.get(sourceNodeId);
        if (!source) return;
        const handle: ConnectionHandle = { nodeId: source.id, handleType: "source" };
        scene.batchDrafts.add(new Path({
            path: activeConnectionPath(source, handle, batch.mouseWorld, target, props.scriptScrollTopById[source.id] || 0),
            stroke,
            strokeWidth: 1.4,
            strokeScaleFixed: true,
            strokeCap: "round",
            dashPattern: [8, 8],
            opacity: 0.72,
            hittable: false,
        }));
    });
}

function syncSelection(rect: Rect, selection: SelectionBox, theme: CanvasTheme) {
    rect.set({
        x: Math.min(selection.startWorldX, selection.currentWorldX),
        y: Math.min(selection.startWorldY, selection.currentWorldY),
        width: Math.abs(selection.currentWorldX - selection.startWorldX),
        height: Math.abs(selection.currentWorldY - selection.startWorldY),
        fill: "transparent",
        stroke: theme.node.label,
        opacity: selection.hitMode === "intersect" ? 0.82 : 0.68,
    });
}

function syncViewport(viewport: ViewportTransform, width: number, height: number, overlay: OverlayScene, props: CanvasLeaferGraphicsLayerProps) {
    const scale = Math.max(viewport.k, 0.05);
    overlay.world.set({ x: viewport.x, y: viewport.y, scaleX: scale, scaleY: scale });

    overlay.selection.set({
        strokeWidth: 1 / scale,
        cornerRadius: 2 / scale,
        dashPattern: [4 / scale, 4 / scale],
    });
    if (props.selectedNodeBounds) syncSelectionBounds(overlay.selectionBounds, liveSelectedNodeBounds(props.selectedNodeBounds, overlay.dragPreview), scale);
    overlay.selectionBounds.set({
        strokeWidth: 1 / scale,
        cornerRadius: 2 / scale,
        dashPattern: [4 / scale, 4 / scale],
        opacity: 0.68,
    });
    overlay.draft.set({ strokeWidth: 1.4 / scale, dashPattern: [8 / scale, 8 / scale] });
    overlay.guides.set({
        visible: typeof props.alignmentGuides.vertical === "number" || typeof props.alignmentGuides.horizontal === "number",
        path: guidePath(viewport, width, height, props.alignmentGuides),
        stroke: props.theme.accent.primary,
        strokeWidth: 1 / scale,
        dashPattern: [5 / scale, 5 / scale],
        opacity: 0.72,
    });
}

function isViewportPreview(container: HTMLDivElement, viewport: ViewportTransform, rasterViewport: ViewportTransform) {
    return container.dataset.canvasViewportInteracting === "true" && !sameCanvasViewport(viewport, rasterViewport);
}

function applyScenePreview(viewport: ViewportTransform, rasterViewport: ViewportTransform, ...scenes: LeaferScene[]) {
    // 将已栅格画面的屏幕坐标映射到实时视口，缩放手势期间不触碰 Leafer 场景树。
    const { ratio, x, y } = calculateCanvasPreviewTransform(viewport, rasterViewport);
    for (const scene of scenes) {
        scene.host.style.transformOrigin = "0 0";
        scene.host.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${ratio})`;
        scene.host.style.willChange = "transform";
        scene.host.dataset.canvasLeaferPreview = "true";
    }
}

function hasScenePreview(...scenes: LeaferScene[]) {
    return scenes.some((scene) => scene.host.dataset.canvasLeaferPreview === "true");
}

function resetScenePreview(...scenes: LeaferScene[]) {
    for (const scene of scenes) {
        scene.host.style.transform = "";
        scene.host.style.transformOrigin = "";
        scene.host.style.willChange = "";
        delete scene.host.dataset.canvasLeaferPreview;
    }
}

function forceSceneRender(...scenes: LeaferScene[]) {
    for (const scene of scenes) scene.leafer.forceRender(undefined, true);
}

function liveSelectedNodeBounds(bounds: NonNullable<NodeBounds>, preview: CanvasNodeDragPreview | null) {
    return offsetSelectedNodeBounds(bounds, preview);
}

function syncLiveSelectionBounds(scene: OverlayScene, props: CanvasLeaferGraphicsLayerProps, viewportScale: number) {
    const bounds = props.selectedNodeBounds;
    const selection = props.selectionBox;
    scene.selectionBounds.visible = Boolean(bounds && !selection && !scene.dragPreview?.compact);
    if (!bounds || selection) return;
    syncSelectionBounds(scene.selectionBounds, liveSelectedNodeBounds(bounds, scene.dragPreview), viewportScale);
    scene.selectionBounds.stroke = props.theme.node.label;
}

function syncSelectionBounds(rect: Rect, bounds: NonNullable<NodeBounds>, viewportScale: number) {
    const padding = 12 / Math.max(viewportScale, 0.05);
    rect.set({
        x: bounds.left - padding,
        y: bounds.top - padding,
        width: bounds.width + padding * 2,
        height: bounds.height + padding * 2,
    });
}

function guidePath(viewport: ViewportTransform, width: number, height: number, guides: { vertical?: number; horizontal?: number }) {
    const scale = Math.max(viewport.k, 0.05);
    const left = -viewport.x / scale;
    const top = -viewport.y / scale;
    const right = left + width / scale;
    const bottom = top + height / scale;
    const commands: string[] = [];
    if (typeof guides.vertical === "number") commands.push(`M ${guides.vertical} ${top} L ${guides.vertical} ${bottom}`);
    if (typeof guides.horizontal === "number") commands.push(`M ${left} ${guides.horizontal} L ${right} ${guides.horizontal}`);
    return commands.join(" ");
}

function canvasPixelRatio() {
    return Math.min(3, Math.max(1, window.devicePixelRatio || 1));
}
