export type CanvasShortcutItem = {
    id: string;
    title: string;
    keys: string[][];
};

export const CANVAS_SHORTCUTS: CanvasShortcutItem[] = [
    { id: "search", title: "搜索画布节点", keys: [["⌘", "F"]] },
    { id: "assistant", title: "打开／关闭助手", keys: [["⌘", "J"]] },
    { id: "focus", title: "进入专注模式", keys: [["⌘", "Shift", "F"]] },
    { id: "move-tool", title: "切换移动工具", keys: [["V"]] },
    { id: "hand-tool", title: "切换抓手工具", keys: [["H"]] },
    { id: "select-all", title: "全选节点", keys: [["⌘", "A"]] },
    { id: "zoom-in", title: "放大画布", keys: [["⌘", "+"]] },
    { id: "zoom-out", title: "缩小画布", keys: [["⌘", "−"]] },
    { id: "actual-size", title: "恢复 100%", keys: [["⌘", "1"]] },
    { id: "fit-canvas", title: "适应全部节点", keys: [["⌘", "0"], ["⌘", "2"]] },
    { id: "fit-selection", title: "适应选中节点", keys: [["⌘", "3"]] },
    { id: "escape", title: "关闭节点搜索", keys: [["Esc"]] },
];
