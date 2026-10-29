import { CANVAS_SHORTCUTS } from "@/lib/canvas/canvas-shortcuts";
import type { CanvasTheme } from "@/lib/canvas-theme";
import "./canvas-shortcuts-popover.css";

export function CanvasShortcutsPopover({ x, theme }: { x: number; theme: CanvasTheme }) {
    const modifier = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
    return (
        <div
            role="dialog"
            aria-label="画布快捷键"
            className="canvas-shortcuts-popover pointer-events-auto"
            style={{ left: `clamp(0px, calc(${x}px - 180px), max(0px, 100% - 360px))`, background: theme.spatial.elevated, borderColor: theme.toolbar.border, color: theme.node.text }}
            onWheel={(event) => event.stopPropagation()}
        >
            <div className="canvas-shortcuts-scroll" tabIndex={0} aria-label="12 个常用快捷键，向下滚动查看全部">
                {CANVAS_SHORTCUTS.map((shortcut) => (
                    <div className="canvas-shortcut-entry" key={shortcut.id}>
                        <span>{shortcut.title}</span>
                        <kbd>{shortcut.keys.map((keys) => keys.map((key) => key === "⌘" ? modifier : key).join(" + ")).join(" / ")}</kbd>
                    </div>
                ))}
            </div>
        </div>
    );
}
