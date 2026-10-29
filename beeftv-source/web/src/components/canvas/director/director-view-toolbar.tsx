import { useMemo, type MouseEvent } from "react";
import { Tooltip } from "@/components/ui/base/tooltip";
import { directorAxisHeads, directorOrientationForMode, type DirectorOrientation } from "@/lib/canvas/director/director-orientation-gizmo";
import { releaseDirectorFocusAfterPointer } from "@/lib/canvas/director/director-shortcuts";
import { DIRECTOR_VIEW_MODES, type DirectorViewMode } from "@/lib/canvas/director/director-view-modes";

type DirectorViewToolbarProps = {
    viewMode: DirectorViewMode;
    orientation?: DirectorOrientation;
    onViewModeChange: (mode: DirectorViewMode) => void;
    onResetView?: () => void;
};

const primaryModes = new Set<DirectorViewMode>(["free", "camera"]);
const primaryLabels: Record<"free" | "camera", string> = { free: "导演视角", camera: "机位视角" };
const axisColors: Record<string, string> = { "x+": "bg-rose-400", "x-": "bg-rose-400", "y+": "bg-emerald-400", "y-": "bg-emerald-400", "z+": "bg-blue-500", "z-": "bg-blue-500" };

/** View selection changes only the observer camera, never scene content or undo history. */
export function DirectorViewToolbar({ viewMode, orientation = [0, 0, 0, 1], onViewModeChange, onResetView }: DirectorViewToolbarProps) {
    const primary = DIRECTOR_VIEW_MODES.filter((item) => primaryModes.has(item.mode));
    const heads = useMemo(() => directorAxisHeads(directorOrientationForMode(viewMode, orientation)), [viewMode, orientation]);
    const chooseMode = (mode: DirectorViewMode, event: MouseEvent<HTMLButtonElement>) => {
        onViewModeChange(mode);
        releaseDirectorFocusAfterPointer(event);
    };

    return <div className="pointer-events-none absolute inset-x-0 top-1.5 z-[var(--z-toolbar)]">
        <div role="group" aria-label="导演台取景模式" className="pointer-events-auto absolute left-1/2 inline-flex -translate-x-1/2 items-center gap-1 rounded-[var(--r-lg)] border p-1 shadow-xl backdrop-blur" style={{ borderColor: "var(--director-sequencer-border)", background: "var(--director-dock-surface)", color: "var(--director-dock-fg)" }}>
            {primary.map((item) => {
                const active = viewMode === item.mode;
                const label = primaryLabels[item.mode as "free" | "camera"];
                return <Tooltip key={item.mode} title={item.hint} placement="bottom"><button type="button" aria-pressed={active} aria-label={label} title={item.hint} className="inline-flex h-8 min-w-20 items-center justify-center whitespace-nowrap rounded-[var(--r-md)] px-3 text-[var(--fs-tiny)] font-medium transition-colors hover:bg-[var(--director-control-hover)] hover:text-[var(--director-dock-fg-strong)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--control-focus-ring)] motion-reduce:transition-none" style={active ? { background: "var(--director-dock-active-surface)", color: "var(--director-dock-fg-strong)" } : undefined} onClick={(event) => chooseMode(item.mode, event)}>{label}</button></Tooltip>;
            })}
        </div>
        <div className="pointer-events-auto absolute right-3 top-3 flex w-[72px] flex-col items-center gap-1.5" role="group" aria-label="方向球">
            <div className="relative size-[72px] rounded-full bg-neutral-900/90 shadow-lg" aria-label="点击轴向切换正交视角">
                <svg aria-hidden="true" className="pointer-events-none absolute inset-0 size-full" viewBox="0 0 72 72">
                    {heads.map((head) => <line key={head.id} x1="36" y1="36" x2={head.x} y2={head.y} className="stroke-white/20" strokeWidth="1" />)}
                </svg>
                {heads.map((head) => {
                    const style = { left: head.x, top: head.y, zIndex: Math.round((head.depth + 1) * 10) };
                    if (!head.mode) return <span key={head.id} aria-hidden="true" className="absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-neutral-600" style={style} />;
                    const emphasized = head.depth > 0.15 || (head.id.endsWith("+") && head.depth >= -0.15);
                    return <button key={head.id} type="button" aria-label={head.label} aria-pressed={viewMode === head.mode} title={head.label} onClick={(event) => chooseMode(head.mode!, event)} className={`absolute flex size-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full text-[10px] font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--control-focus-ring)] ${emphasized ? axisColors[head.id] : "bg-neutral-600"}`} style={style}>{emphasized ? head.id[0].toUpperCase() : ""}</button>;
                })}
            </div>
            <button type="button" aria-label="重置视角" onClick={(event) => { onResetView?.(); releaseDirectorFocusAfterPointer(event); }} className="w-full rounded-md bg-neutral-900/90 py-0.5 text-[11px] text-white/70 transition-colors hover:bg-neutral-800 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--control-focus-ring)] motion-reduce:transition-none">重置视角</button>
        </div>
    </div>;
}
