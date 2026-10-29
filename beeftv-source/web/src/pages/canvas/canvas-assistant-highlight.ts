/**
 * 助手刚改过的节点在画布上短暂点亮。
 *
 * 画布刚拉到新内容时节点可能还没挂上，所以分几次尝试；找不到就安静放过，
 * 这只是定位提示，不该影响画布本身。
 */
const HIGHLIGHT_CLASS = "canvas-assistant-touched";
const RETRY_DELAYS = [0, 220, 600];

export function highlightAssistantNodes(container: HTMLElement | null, nodeIds: readonly string[], durationMs = 3000) {
    if (!container || !nodeIds.length || typeof window === "undefined") return;
    const marked = new Set<string>();
    for (const delay of RETRY_DELAYS) {
        window.setTimeout(() => {
            for (const id of nodeIds) {
                if (marked.has(id)) continue;
                const element = container.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(id)}"]`);
                if (!element) continue;
                marked.add(id);
                element.classList.add(HIGHLIGHT_CLASS);
                window.setTimeout(() => element.classList.remove(HIGHLIGHT_CLASS), durationMs);
            }
        }, delay);
    }
}
