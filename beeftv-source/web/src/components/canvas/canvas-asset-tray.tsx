import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ChevronDown, CircleUserRound, Crosshair, ImageIcon, Images, Plus, Search, X } from "lucide-react";

import { FloatingDock, type FloatingDockEntry } from "@/components/ui/aceternity/floating-dock";
import { AssetMediaPreview } from "@/components/asset-media-preview";
import { CachedResourceImage } from "@/components/cached-resource-image";
import { useCanvasOverlayLayer } from "@/components/canvas/canvas-overlay-layer";
import { aceternityMotion } from "@/lib/aceternity-motion";
import { canvasDockStyle } from "@/lib/canvas/canvas-aceternity-style";
import { canvasThemes } from "@/lib/canvas-theme";
import { cn } from "@/lib/utils";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";
import type { Asset, ImageAsset } from "@/stores/use-asset-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

export const CANVAS_IMAGE_ASSET_DND_TYPE = "application/x-infinite-canvas-image-asset";

type TrayTab = "library" | "canvas";

const TRAY_DEFAULT_HEIGHT = 520;
const TRAY_MIN_HEIGHT = 400;
const TRAY_BOTTOM_SAFE_SPACE = 82;

type ResizeSession = {
    pointerId: number;
    startY: number;
    startHeight: number;
    nextHeight: number;
    frameId: number | null;
};

function getMaxTrayHeight() {
    if (typeof window === "undefined") return 520;
    return Math.max(360, window.innerHeight - TRAY_BOTTOM_SAFE_SPACE);
}

function clampTrayHeight(height: number) {
    const maxHeight = getMaxTrayHeight();
    const minHeight = Math.min(TRAY_MIN_HEIGHT, maxHeight);
    return Math.min(Math.max(height, minHeight), maxHeight);
}

type TrayAsset = Extract<Asset, { kind: "image" | "video" | "audio" | "text" }>;

type CanvasAssetTrayProps = {
    libraryAssets: TrayAsset[];
    canvasImages: CanvasNodeData[];
    showLibrary?: boolean;
    activeNodeId?: string | null;
    onInsertAsset: (asset: TrayAsset) => void;
    onFocusCanvasImage: (nodeId: string) => void;
    libtvReadonlyDense?: boolean;
};

export function CanvasAssetTray({ libraryAssets, canvasImages, showLibrary = true, activeNodeId, onInsertAsset, onFocusCanvasImage, libtvReadonlyDense = false }: CanvasAssetTrayProps) {
    const theme = canvasThemes[useActiveTheme()];
    const reducedMotion = useReducedMotion();
    const { bringToFront, zIndex } = useCanvasOverlayLayer("asset-tray", "var(--z-panel)");
    const rootRef = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    const [desktopDockLabels, setDesktopDockLabels] = useState(() => typeof window !== "undefined" && window.innerWidth >= 1024);
    const [tab, setTab] = useState<TrayTab>(() => showLibrary ? "library" : "canvas");
    const [keyword, setKeyword] = useState("");
    const [trayHeight, setTrayHeight] = useState(() => clampTrayHeight(TRAY_DEFAULT_HEIGHT));
    const panelRef = useRef<HTMLElement>(null);
    const resizeRef = useRef<ResizeSession | null>(null);
    const resizeCleanupRef = useRef<(() => void) | null>(null);
    const resizeHandleRef = useRef<{ element: HTMLButtonElement; pointerId: number } | null>(null);
    const query = keyword.trim().toLowerCase();
    const filteredAssets = useMemo(() => libraryAssets.filter((asset) => !query || [asset.title, ...(asset.tags || [])].join(" ").toLowerCase().includes(query)), [libraryAssets, query]);
    const filteredNodes = useMemo(() => canvasImages.filter((node) => {
        if (!query) return true;
        // Generated nodes can expose their useful search text through workflowTitle
        // or prompt even when the compact card title is only “S01/S02”.
        return [canvasImageTitle(node), node.metadata?.workflowTitle || "", node.metadata?.prompt || ""].join(" ").toLowerCase().includes(query);
    }), [canvasImages, query]);
    const safeTrayHeight = clampTrayHeight(trayHeight);

    useEffect(() => {
        const updateDockLabels = () => setDesktopDockLabels(window.innerWidth >= 1024);
        window.addEventListener("resize", updateDockLabels);
        return () => window.removeEventListener("resize", updateDockLabels);
    }, []);
    const motionEnabled = !reducedMotion;

    const startAssetDrag = (event: DragEvent<HTMLElement>, asset: ImageAsset) => {
        event.dataTransfer.effectAllowed = "copy";
        event.dataTransfer.setData(CANVAS_IMAGE_ASSET_DND_TYPE, asset.id);
        event.dataTransfer.setData("text/plain", asset.title);
    };

    const paintResize = useCallback(() => {
        const session = resizeRef.current;
        if (!session || session.frameId !== null) return;
        session.frameId = window.requestAnimationFrame(() => {
            session.frameId = null;
            if (resizeRef.current !== session || !panelRef.current) return;
            panelRef.current.style.height = String(session.nextHeight) + "px";
        });
    }, []);

    const stopResize = useCallback(() => {
        const session = resizeRef.current;
        if (!session) return;
        resizeCleanupRef.current?.();
        resizeCleanupRef.current = null;
        if (session.frameId !== null) {
            window.cancelAnimationFrame(session.frameId);
            session.frameId = null;
        }
        const finalHeight = session.nextHeight;
        if (panelRef.current) {
            panelRef.current.style.height = String(finalHeight) + "px";
            panelRef.current.classList.remove("is-resizing");
        }
        const handle = resizeHandleRef.current;
        if (handle?.element.hasPointerCapture(handle.pointerId)) handle.element.releasePointerCapture(handle.pointerId);
        resizeHandleRef.current = null;
        resizeRef.current = null;
        setTrayHeight(finalHeight);
    }, []);

    const startResize = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
        event.preventDefault();
        event.stopPropagation();
        stopResize();
        const session: ResizeSession = { pointerId: event.pointerId, startY: event.clientY, startHeight: safeTrayHeight, nextHeight: safeTrayHeight, frameId: null };
        const updateHeight = (moveEvent: PointerEvent) => {
            if (moveEvent.pointerId !== session.pointerId) return;
            session.nextHeight = clampTrayHeight(session.startHeight + session.startY - moveEvent.clientY);
            paintResize();
        };
        const finish = (endEvent: PointerEvent) => {
            if (endEvent.pointerId === session.pointerId) stopResize();
        };
        resizeRef.current = session;
        resizeHandleRef.current = { element: event.currentTarget, pointerId: event.pointerId };
        panelRef.current?.classList.add("is-resizing");
        event.currentTarget.setPointerCapture(event.pointerId);
        window.addEventListener("pointermove", updateHeight);
        window.addEventListener("pointerup", finish);
        window.addEventListener("pointercancel", finish);
        resizeCleanupRef.current = () => {
            window.removeEventListener("pointermove", updateHeight);
            window.removeEventListener("pointerup", finish);
            window.removeEventListener("pointercancel", finish);
        };
    }, [paintResize, safeTrayHeight, stopResize]);

    useEffect(() => () => {
        resizeCleanupRef.current?.();
        const session = resizeRef.current;
        if (session && session.frameId !== null) window.cancelAnimationFrame(session.frameId);
        resizeRef.current = null;
    }, []);

    useEffect(() => {
        const syncHeight = () => setTrayHeight((height) => clampTrayHeight(height));
        window.addEventListener("resize", syncHeight);
        return () => window.removeEventListener("resize", syncHeight);
    }, []);

    useEffect(() => {
        if (!showLibrary && tab === "library") setTab("canvas");
    }, [showLibrary, tab]);

    useEffect(() => {
        if (!open) return;
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape") setOpen(false);
        };
        document.addEventListener("keydown", closeOnEscape);
        return () => {
            document.removeEventListener("keydown", closeOnEscape);
        };
    }, [open]);

    const dockItems: FloatingDockEntry[] = [
        {
            id: "asset-tray-toggle",
            label: open ? "收起素材空间" : `打开素材空间，共 ${(showLibrary ? libraryAssets.length : 0) + canvasImages.length} 项`,
            displayLabel: libtvReadonlyDense ? "" : "资产管理",
            icon: libtvReadonlyDense ? <CircleUserRound /> : <span className="relative"><Images /><span className="absolute -right-1.5 -top-1.5 min-w-3 rounded-full px-0.5 text-center text-[var(--fs-nano)] font-bold leading-3" style={{ background: theme.accent.primary, color: theme.accent.onPrimary }}>{(showLibrary ? libraryAssets.length : 0) + canvasImages.length}</span></span>,
            active: open,
            onClick: () => {
                bringToFront();
                setOpen((value) => !value);
            },
        },
    ];

    return (
        <div ref={rootRef} data-canvas-no-zoom className="relative w-max shrink-0" style={{ zIndex }} onPointerDownCapture={bringToFront} onFocusCapture={bringToFront} onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
            <AnimatePresence>
                {open ? (
                    <motion.aside
                        initial={{ opacity: 0, y: 20, scale: 0.92, rotateX: 5 }}
                        animate={{ opacity: 1, y: 0, scale: 1, rotateX: 0 }}
                        exit={{ opacity: 0, y: 14, scale: 0.95, rotateX: 3 }}
                        transition={aceternityMotion.spring.panel}
                        ref={panelRef}
                        data-canvas-asset-tray
                        className="canvas-asset-tray-panel aceternity-floating-panel absolute bottom-[var(--canvas-dock-popover-offset)] left-0 flex w-[min(88vw,312px)] origin-bottom-left flex-col overflow-hidden rounded-[var(--r-2xl)] p-2.5 backdrop-blur-2xl"
                        style={{ background: theme.spatial.elevated, color: theme.node.text, height: safeTrayHeight, minHeight: Math.min(TRAY_MIN_HEIGHT, getMaxTrayHeight()), maxHeight: "calc(100vh - 6rem)", boxShadow: `0 32px 100px ${theme.spatial.shadow}` }}
                    >
                        <button type="button" className="canvas-asset-tray-resize-handle absolute left-1/2 top-1 z-10 flex h-5 w-28 -translate-x-1/2 items-center justify-center rounded-full opacity-35 transition-opacity hover:opacity-75" onPointerDown={startResize} aria-label="从顶部调整素材托盘高度" title="拖动调整高度">
                            <span className="h-1 w-12 rounded-full bg-current" />
                        </button>

                        <div className="flex justify-end px-1 pb-2.5 pt-1.5">
                            <motion.button type="button" whileHover={motionEnabled ? { rotate: -5, scale: 1.05 } : undefined} whileTap={motionEnabled ? { scale: 0.92 } : undefined} className="grid size-7 shrink-0 place-items-center rounded-full outline-none focus-visible:ring-2" style={{ background: theme.spatial.surface, color: theme.node.muted }} onClick={() => setOpen(false)} aria-label="收起素材空间">
                                <ChevronDown className="size-4" />
                            </motion.button>
                        </div>

                        <div className={cn("relative grid gap-1 rounded-[var(--r-lg)] p-0.5", showLibrary ? "grid-cols-2" : "grid-cols-1")} style={{ background: theme.spatial.surface }}>
                            {showLibrary ? <TrayTabButton active={tab === "library"} label={`个人资产库 ${libraryAssets.length}`} theme={theme} onClick={() => setTab("library")} /> : null}
                            <TrayTabButton active={tab === "canvas"} label={`当前画布 ${canvasImages.length}`} theme={theme} onClick={() => setTab("canvas")} />
                        </div>

                        <label className="mt-2 flex h-8 items-center gap-1.5 rounded-[11px] px-2.5 focus-within:ring-2" style={{ background: theme.spatial.surface }}>
                            <Search className="size-3.5 shrink-0" style={{ color: theme.node.muted }} />
                            <input type="search" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索资产..." className="min-w-0 flex-1 bg-transparent text-[var(--fs-tiny)] outline-none placeholder:opacity-55" aria-label="搜索资产" />
                            {keyword ? <button type="button" className="grid size-6 shrink-0 place-items-center rounded-full opacity-55 hover:opacity-100" onClick={() => setKeyword("")} aria-label="清空搜索"><X className="size-3" /></button> : null}
                        </label>

                        <div className="thin-scrollbar mt-2.5 min-h-0 flex-1 overflow-x-hidden overflow-y-auto pr-1">
                            {showLibrary && tab === "library" ? (
                                filteredAssets.length ? (
                                    <div className="space-y-1.5">
                                        {filteredAssets.map((asset) => (
                                            <AssetTrayRow key={asset.id} title={asset.title} imageUrl="" asset={asset} insertable draggable={asset.kind === "image"} motionEnabled={motionEnabled} onDragStart={asset.kind === "image" ? (event) => startAssetDrag(event, asset) : undefined} onClick={() => onInsertAsset(asset)} icon={<Plus className="size-3.5" />} />
                                        ))}
                                    </div>
                                ) : (
                                    <TrayEmpty text="没有匹配的资产" theme={theme} />
                                )
                            ) : filteredNodes.length ? (
                                <div className="space-y-1.5">
                        {filteredNodes.map((node) => (
                            <AssetTrayRow key={node.id} title={canvasImageTitle(node)} imageUrl={node.metadata?.content || node.metadata?.previewContent || ""} storageKey={node.metadata?.storageKey} active={activeNodeId === node.id} motionEnabled={motionEnabled} onClick={() => onFocusCanvasImage(node.id)} icon={<Crosshair className="size-3.5" />} />
                                    ))}
                                </div>
                            ) : (
                                <TrayEmpty text="当前画布没有匹配图片" theme={theme} />
                            )}
                        </div>

                    </motion.aside>
                ) : null}
            </AnimatePresence>

            <FloatingDock
                items={dockItems}
                className="canvas-floating-dock canvas-asset-tray-dock"
                style={{
                    ...canvasDockStyle(theme),
                    width: desktopDockLabels ? 92 : 30,
                    minWidth: desktopDockLabels ? 92 : 30,
                    flex: "0 0 auto",
                    ...(desktopDockLabels ? { background: "transparent", borderColor: "transparent", boxShadow: "none" } : {}),
                }}
                ariaLabel="素材空间"
                showLabels={libtvReadonlyDense ? false : desktopDockLabels}
                embedded={libtvReadonlyDense ? false : desktopDockLabels}
            />
        </div>
    );
}

type CanvasTheme = (typeof canvasThemes)[keyof typeof canvasThemes];

function TrayTabButton({ active, label, theme, onClick }: { active: boolean; label: string; theme: CanvasTheme; onClick: () => void }) {
    return (
        <button type="button" className={cn("relative z-10 h-7 rounded-[var(--dock-item-radius)] px-2 text-[var(--fs-tiny)] font-semibold outline-none transition-colors focus-visible:ring-2", active ? "" : "opacity-55 hover:opacity-90")} style={{ color: active ? theme.node.text : theme.node.muted }} onClick={onClick}>
            {active ? <motion.span layoutId="canvas-asset-tray-active-tab" className="absolute inset-0 -z-10 rounded-[var(--dock-item-radius)]" style={{ background: theme.node.panel, boxShadow: `0 6px 16px ${theme.spatial.shadow}` }} transition={aceternityMotion.spring.dock} /> : null}
            {label}
        </button>
    );
}

function AssetTrayRow({ title, imageUrl, storageKey, asset, insertable = false, icon, active = false, draggable = false, motionEnabled, onClick, onDragStart }: { title: string; imageUrl: string; storageKey?: string; asset?: Asset; insertable?: boolean; icon: ReactNode; active?: boolean; draggable?: boolean; motionEnabled: boolean; onClick: () => void; onDragStart?: (event: DragEvent<HTMLElement>) => void }) {
    const theme = canvasThemes[useActiveTheme()];
    return (
        <motion.button
            type="button"
            data-canvas-asset-row
            aria-label={`${title}，${active ? "当前已选择" : draggable ? "拖入画布或点击插入" : insertable ? "点击插入画布" : "点击定位到画布"}`}
            draggable={draggable}
            whileHover={motionEnabled ? { x: 4, scale: 1.008 } : undefined}
            whileTap={motionEnabled ? { scale: 0.985 } : undefined}
            transition={aceternityMotion.spring.dock}
            className="group grid h-12 w-full grid-cols-[36px_minmax(0,1fr)_24px] items-center gap-1.5 rounded-[var(--r-lg)] px-1.5 text-left outline-none focus-visible:ring-2"
            style={{ background: active ? theme.accent.primarySoft : theme.spatial.surface, color: active ? theme.accent.primary : theme.node.text, boxShadow: active ? `0 6px 18px ${theme.spatial.shadow}` : undefined }}
            onClick={onClick}
            onDragStartCapture={onDragStart}
        >
            <span className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-[var(--dock-item-radius)]" style={{ background: theme.node.fill }}>
                {asset ? <AssetMediaPreview asset={asset} alt={title} className="size-full object-cover" hoverPlayDelayMs={100} fallback={<ImageIcon className="size-3.5 opacity-55" />} /> : imageUrl || storageKey ? <CachedResourceImage storageKey={storageKey} src={imageUrl} alt="" width={36} height={36} className="size-full object-cover" draggable={false} fallback={<ImageIcon className="size-3.5 opacity-55" />} /> : <ImageIcon className="size-3.5 opacity-55" />}
            </span>
            <span className="min-w-0">
                <span className="block truncate text-[var(--fs-tiny)] font-semibold">{title}</span>
            </span>
            <span className="grid size-6 place-items-center rounded-full opacity-45 transition-opacity group-hover:opacity-90" style={{ background: theme.node.panel }}>{icon}</span>
        </motion.button>
    );
}

function TrayEmpty({ text, theme }: { text: string; theme: CanvasTheme }) {
    return (
        <div className="grid h-full min-h-[200px] place-items-center rounded-[var(--dock-radius)] text-center" style={{ background: theme.spatial.surface, color: theme.node.muted }}>
            <span><Images className="mx-auto size-5 opacity-35" /><span className="mt-2 block text-xs opacity-55">{text}</span></span>
        </div>
    );
}

function canvasImageTitle(node: CanvasNodeData) {
    if (node.type !== CanvasNodeType.Image) return node.title;
    return node.title || node.metadata?.prompt || "图片节点";
}
