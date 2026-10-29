import { AnimatePresence, motion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Focus, Grid3X3, LayoutTemplate, Link2, Map } from "lucide-react";

import { FloatingDock, type FloatingDockEntry } from "@/components/ui/aceternity/floating-dock";
import { aceternityMotion } from "@/lib/aceternity-motion";
import { canvasDockStyle } from "@/lib/canvas/canvas-aceternity-style";
import { canvasThemes } from "@/lib/canvas-theme";
import { subscribeCanvasViewportPreview } from "@/lib/canvas/canvas-live-viewport";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";

type CanvasZoomControlsProps = {
    scale: number;
    onScaleChange: (scale: number) => void;
    onFitContent: () => void;
    onAutoArrange?: () => void;
    snapToGrid: boolean;
    onSnapToGridChange: (enabled: boolean) => void;
    showConnections: boolean;
    onToggleConnections: () => void;
    isMiniMapOpen: boolean;
    onToggleMiniMap: () => void;
    containerRef?: RefObject<HTMLDivElement | null>;
    libtvChrome?: boolean;
};

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 8;
const ZOOM_STEP = 0.1;
const ZOOM_MENU_HALF_WIDTH = 92;
const QUICK_ZOOM_LEVELS = [0.5, 1, 8] as const;

export function CanvasZoomControls({ scale, onScaleChange, onFitContent, onAutoArrange, snapToGrid, onSnapToGridChange, showConnections, onToggleConnections, isMiniMapOpen, onToggleMiniMap, containerRef, libtvChrome = false }: CanvasZoomControlsProps) {
    const theme = canvasThemes[useActiveTheme()];
    const rootRef = useRef<HTMLDivElement>(null);
    const liveScaleRef = useRef(scale);
    const inputRef = useRef<HTMLInputElement>(null);
    const dockLabelRef = useRef<HTMLSpanElement>(null);
    const [precisionOpen, setPrecisionOpen] = useState(false);
    const [desktopCompactDock, setDesktopCompactDock] = useState(() => typeof window !== "undefined" && window.innerWidth >= 1024);
    const [precisionAnchorX, setPrecisionAnchorX] = useState<number | null>(null);

    useEffect(() => updateScaleDisplay(scale), [scale]);

    useEffect(() => {
        const container = containerRef?.current;
        if (!container) return;
        return subscribeCanvasViewportPreview(container, (viewport) => updateScaleDisplay(viewport.k));
    }, [containerRef]);

    useEffect(() => {
        if (!precisionOpen) return;
        const close = (event: PointerEvent) => {
            if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setPrecisionOpen(false);
        };
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape") setPrecisionOpen(false);
        };
        document.addEventListener("pointerdown", close, true);
        document.addEventListener("keydown", closeOnEscape);
        return () => {
            document.removeEventListener("pointerdown", close, true);
            document.removeEventListener("keydown", closeOnEscape);
        };
    }, [precisionOpen]);

    useEffect(() => {
        const updateDockMode = () => setDesktopCompactDock(window.innerWidth >= 1024);
        window.addEventListener("resize", updateDockMode);
        return () => window.removeEventListener("resize", updateDockMode);
    }, []);

    useLayoutEffect(() => {
        if (!desktopCompactDock) {
            setPrecisionAnchorX(null);
            return;
        }
        const root = rootRef.current;
        const button = root?.querySelector<HTMLButtonElement>('button[aria-label="缩放画布"]');
        if (!root || !button) return;
        const updateAnchor = () => {
            const rootRect = root.getBoundingClientRect();
            const buttonRect = button.getBoundingClientRect();
            const next = buttonRect.left - rootRect.left + buttonRect.width / 2;
            setPrecisionAnchorX((current) => current !== null && Math.abs(current - next) < 0.25 ? current : next);
        };
        updateAnchor();
        const observer = new ResizeObserver(updateAnchor);
        observer.observe(root);
        observer.observe(button);
        window.addEventListener("resize", updateAnchor);
        return () => {
            observer.disconnect();
            window.removeEventListener("resize", updateAnchor);
        };
    }, [desktopCompactDock]);

    function updateScaleDisplay(nextScale: number) {
        liveScaleRef.current = nextScale;
        const percent = String(Math.round(nextScale * 100));
        if (inputRef.current && document.activeElement !== inputRef.current) inputRef.current.value = percent;
        if (dockLabelRef.current) dockLabelRef.current.textContent = percent;
    }

    function commitScale(nextScale: number) {
        const clampedScale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextScale));
        updateScaleDisplay(clampedScale);
        onScaleChange(clampedScale);
    }

    function commitInputScale() {
        const input = inputRef.current;
        if (!input) return;
        const nextPercent = Number.parseFloat(input.value.replace(/[^\d.]/g, ""));
        if (!Number.isFinite(nextPercent)) {
            input.value = String(Math.round(liveScaleRef.current * 100));
            return;
        }
        commitScale(nextPercent / 100);
        input.value = String(Math.round(liveScaleRef.current * 100));
    }

    function runMenuAction(action: () => void) {
        action();
        setPrecisionOpen(false);
    }

    const items: FloatingDockEntry[] = [
        { id: "zoom-connections", label: showConnections ? "隐藏节点连线" : "显示节点连线", icon: <Link2 />, active: showConnections, onClick: onToggleConnections },
        { id: "zoom-minimap", label: "切换小地图", icon: <Map />, active: isMiniMapOpen, onClick: onToggleMiniMap },
        { id: "zoom-snap-grid", label: "网格吸附", icon: <Grid3X3 />, active: snapToGrid, onClick: () => onSnapToGridChange(!snapToGrid) },
        { id: "zoom-fit", label: "适合屏幕", icon: <Focus />, onClick: onFitContent },
        ...(onAutoArrange ? [{ id: "zoom-auto-arrange", label: "自动整理节点", icon: <LayoutTemplate />, onClick: onAutoArrange }] : []),
        {
            id: "zoom-precision",
            label: "缩放画布",
            wide: true,
            quiet: true,
            expands: true,
            icon: <span className="inline-flex h-full items-center justify-center whitespace-nowrap text-[12px] font-medium leading-none tabular-nums"><span ref={dockLabelRef}>{Math.round(scale * 100)}</span><span className="ml-px text-[10px] font-normal leading-none opacity-50">%</span></span>,
            active: precisionOpen,
            onClick: () => setPrecisionOpen((value) => !value),
        },
    ];

    return (
        <div ref={rootRef} data-canvas-no-zoom className={`relative z-[var(--z-toolbar)]${libtvChrome ? " canvas-libtv-compat-zoom" : ""}`} onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
            <AnimatePresence>
                {precisionOpen ? (
                    <motion.div
                        initial={{ opacity: 0, y: 14, scale: 0.92 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 9, scale: 0.96 }}
                        transition={aceternityMotion.spring.panel}
                        role="dialog"
                        aria-label="缩放画布"
                        className="canvas-zoom-menu aceternity-floating-panel absolute bottom-[var(--canvas-dock-popover-offset)] left-0 overflow-hidden border backdrop-blur-2xl"
                        style={{ left: precisionAnchorX ?? undefined, x: precisionAnchorX === null ? 0 : -ZOOM_MENU_HALF_WIDTH, background: theme.spatial.elevated, borderColor: theme.toolbar.border, color: theme.node.text, boxShadow: `0 28px 80px ${theme.spatial.shadow}` }}
                    >
                        <label className="canvas-zoom-menu-input" style={{ background: theme.spatial.surface }}>
                            <input
                                ref={inputRef}
                                type="text"
                                inputMode="decimal"
                                defaultValue={Math.round(scale * 100)}
                                aria-label="输入画布缩放百分比"
                                autoComplete="off"
                                spellCheck={false}
                                onFocus={(event) => event.currentTarget.select()}
                                onBlur={commitInputScale}
                                onKeyDown={(event) => {
                                    if (event.key === "Enter") {
                                        event.preventDefault();
                                        commitInputScale();
                                        setPrecisionOpen(false);
                                    } else if (event.key === "Escape") {
                                        event.preventDefault();
                                        inputRef.current!.value = String(Math.round(liveScaleRef.current * 100));
                                        setPrecisionOpen(false);
                                    }
                                }}
                            />
                            <span aria-hidden>%</span>
                        </label>

                        <div className="canvas-zoom-menu-actions">
                            <button type="button" onClick={() => runMenuAction(() => commitScale(liveScaleRef.current + ZOOM_STEP))}>
                                <span>放大</span><span className="canvas-zoom-shortcut" aria-hidden><kbd>⌘</kbd><span>＋</span></span>
                            </button>
                            <button type="button" onClick={() => runMenuAction(() => commitScale(liveScaleRef.current - ZOOM_STEP))}>
                                <span>缩小</span><span className="canvas-zoom-shortcut" aria-hidden><kbd>⌘</kbd><span>−</span></span>
                            </button>
                            <button type="button" onClick={() => runMenuAction(onFitContent)}>
                                <span>适合屏幕</span><span className="canvas-zoom-shortcut" aria-hidden><kbd>⌘</kbd><span>0</span></span>
                            </button>
                        </div>

                        <div className="canvas-zoom-menu-divider" />

                        <div className="canvas-zoom-menu-presets">
                            {QUICK_ZOOM_LEVELS.map((level) => (
                                <button key={level} type="button" onClick={() => runMenuAction(() => commitScale(level))}>
                                    缩放至{Math.round(level * 100)}%
                                </button>
                            ))}
                        </div>
                    </motion.div>
                ) : null}
            </AnimatePresence>

            <FloatingDock
                items={items}
                className="canvas-floating-dock"
                style={{
                    ...canvasDockStyle(theme),
                    ...(desktopCompactDock ? { background: "transparent", borderColor: "transparent", boxShadow: "none" } : {}),
                }}
                ariaLabel="画布视图控制"
                embedded={desktopCompactDock}
            />
        </div>
    );
}
