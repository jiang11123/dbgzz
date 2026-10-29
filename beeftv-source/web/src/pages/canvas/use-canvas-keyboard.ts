import { useEffect, type Dispatch, type SetStateAction } from "react";

import { isTextEditableTarget } from "@/lib/backspace-navigation-guard";
import type { CanvasNodeData, ContextMenuState } from "@/types/canvas";

type UseCanvasKeyboardOptions = {
    enabled?: boolean;
    nodesRef: { current: CanvasNodeData[] };
    selectedNodeIdsRef: { current: Set<string> };
    selectedConnectionId: string | null;
    setSelectedNodeIds: Dispatch<SetStateAction<Set<string>>>;
    setSelectedConnectionId: Dispatch<SetStateAction<string | null>>;
    setContextMenu: Dispatch<SetStateAction<ContextMenuState | null>>;
    setShortcutRequestNonce: Dispatch<SetStateAction<number>>;
    setInfoNodeId: Dispatch<SetStateAction<string | null>>;
    setCropNodeId: Dispatch<SetStateAction<string | null>>;
    setMaskEditNodeId: Dispatch<SetStateAction<string | null>>;
    setAnnotationNodeId: Dispatch<SetStateAction<string | null>>;
    saveCanvasProject: () => unknown;
    zoomToActualSize: () => void;
    fitCanvasContent: () => void;
    fitCanvasSelection: () => void;
    undoCanvas: () => void;
    redoCanvas: () => void;
    cancelSelectionBox: () => void;
    copySelectedNodes: () => void;
    pasteCopiedNodes: () => boolean;
    restoreCopiedNodesFromText: (value: string) => boolean;
    shouldPreferCopiedNodes: () => boolean;
    pasteSystemClipboard: (position?: undefined, clipboardEvent?: ClipboardEvent | null) => Promise<boolean> | boolean;
    deleteNodes: (ids: Set<string>) => void;
    deleteConnection: (connectionId: string) => void;
    deselectCanvas: () => void;
    zoomCanvasIn: () => void;
    zoomCanvasOut: () => void;
    autoArrangeCanvasNodes: () => void;
    focusMode: boolean;
    exitFocusMode: () => void;
    toggleFocusMode: () => void;
    onOpenSearch: () => void;
    onToggleAssistant?: () => void;
    beginBatchConnection: () => void;
};

type TextSelectionLike = {
    isCollapsed: boolean;
    rangeCount: number;
    toString(): string;
};

export function hasCanvasTextSelection(selection: TextSelectionLike | null | undefined) {
    return Boolean(selection && !selection.isCollapsed && selection.rangeCount > 0 && selection.toString());
}

export function useCanvasKeyboard({
    enabled = true,
    nodesRef,
    selectedNodeIdsRef,
    selectedConnectionId,
    setSelectedNodeIds,
    setSelectedConnectionId,
    setContextMenu,
    setShortcutRequestNonce,
    setInfoNodeId,
    setCropNodeId,
    setMaskEditNodeId,
    setAnnotationNodeId,
    saveCanvasProject,
    zoomToActualSize,
    fitCanvasContent,
    fitCanvasSelection,
    undoCanvas,
    redoCanvas,
    cancelSelectionBox,
    copySelectedNodes,
    pasteCopiedNodes,
    restoreCopiedNodesFromText,
    shouldPreferCopiedNodes,
    pasteSystemClipboard,
    deleteNodes,
    deleteConnection,
    deselectCanvas,
    zoomCanvasIn,
    zoomCanvasOut,
    autoArrangeCanvasNodes,
    focusMode,
    exitFocusMode,
    toggleFocusMode,
    onOpenSearch,
    onToggleAssistant,
    beginBatchConnection,
}: UseCanvasKeyboardOptions) {
    useEffect(() => {
        if (!enabled) return;
        const handleKeyDown = (event: KeyboardEvent) => {
            // Unconsumed Backspace is a history back in the desktop webview and
            // leaves the canvas route. Consume the default before any early
            // return below (director, node toolbar, canvas controls) but keep
            // propagation so their own handlers still receive the key.
            if ((event.key === "Delete" || event.key === "Backspace") && !isTextEditableTarget(event.target)) event.preventDefault();
            // Runtime guard complements the React `enabled` flag: the workbench
            // owns keyboard input whenever mounted, regardless of stale canvas selection.
            if (document.querySelector("[data-director-workbench='true']")) return;
            const target = event.target instanceof Element ? event.target : null;
            if (target?.closest(".canvas-node-toolbar, .canvas-node-toolbar-menu")) return;
            const key = event.key.toLowerCase();
            const isModifierShortcut = event.metaKey || event.ctrlKey;
            const isTextEditingTarget = isTextEditableTarget(event.target) || isTextEditableTarget(document.activeElement);

            if (isModifierShortcut && !event.altKey && (key === "+" || key === "=" || event.code === "NumpadAdd")) {
                event.preventDefault();
                if (!isTextEditingTarget) zoomCanvasIn();
                return;
            }
            if (isModifierShortcut && !event.altKey && (key === "-" || key === "_" || event.code === "NumpadSubtract")) {
                event.preventDefault();
                if (!isTextEditingTarget) zoomCanvasOut();
                return;
            }
            if (isModifierShortcut && !event.altKey && (key === "0" || event.code === "Numpad0")) {
                event.preventDefault();
                if (!isTextEditingTarget) fitCanvasContent();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "s") {
                event.preventDefault();
                event.stopPropagation();
                if (!event.repeat) void saveCanvasProject();
                return;
            }
            if (isModifierShortcut && !event.altKey && key === "f") {
                if (target?.closest(".ant-modal-wrap, .ant-dropdown, .ant-popover")) return;
                event.preventDefault();
                event.stopPropagation();
                if (!event.repeat) {
                    if (event.shiftKey) toggleFocusMode();
                    else onOpenSearch();
                }
                return;
            }
            // 助手开合在输入框里也要能用（面板自己的输入框就是输入框）。
            if (isModifierShortcut && !event.altKey && !event.shiftKey && key === "j") {
                if (target?.closest(".ant-modal-wrap, .ant-dropdown, .ant-popover")) return;
                event.preventDefault();
                event.stopPropagation();
                if (!event.repeat) onToggleAssistant?.();
                return;
            }
            if (isTextEditingTarget) return;
            const isCanvasControlTarget = Boolean(target?.closest("[data-canvas-no-zoom]"));
            if (isCanvasControlTarget && !(isModifierShortcut && !event.altKey && (key === "c" || key === "v"))) return;
            if (event.altKey && event.shiftKey && !isModifierShortcut && key === "f") {
                if (target?.closest(".ant-modal-wrap, .ant-dropdown, .ant-popover")) return;
                event.preventDefault();
                if (!event.repeat) autoArrangeCanvasNodes();
                return;
            }
            if (event.altKey && !isModifierShortcut && key === "l") {
                event.preventDefault();
                if (!event.repeat && selectedNodeIdsRef.current.size > 1) beginBatchConnection();
                return;
            }
            if (event.key === "?" && !isModifierShortcut && !event.altKey) {
                event.preventDefault();
                setShortcutRequestNonce((value) => value + 1);
                return;
            }
            if (isModifierShortcut && !event.altKey && (key === "1" || key === "2" || key === "3")) {
                event.preventDefault();
                if (key === "1") zoomToActualSize();
                else if (key === "2") fitCanvasContent();
                else fitCanvasSelection();
                return;
            }
            if (isModifierShortcut && !event.altKey && key === "z") {
                event.preventDefault();
                if (event.shiftKey) redoCanvas();
                else undoCanvas();
                return;
            }
            if (isModifierShortcut && !event.altKey && key === "y") {
                event.preventDefault();
                redoCanvas();
                return;
            }
            if (isModifierShortcut && !event.altKey && key === "a") {
                event.preventDefault();
                setSelectedNodeIds(new Set(nodesRef.current.map((node) => node.id)));
                setSelectedConnectionId(null);
                setContextMenu(null);
                cancelSelectionBox();
                return;
            }
            if (isModifierShortcut && !event.altKey && key === "c") {
                if (hasCanvasTextSelection(window.getSelection())) return;
                event.preventDefault();
                copySelectedNodes();
                return;
            }
            if (isModifierShortcut && !event.altKey && key === "v") {
                // 有些浏览器/焦点状态不会继续派发 paste 事件；内部节点复制必须有 keydown 兜底。
                if (shouldPreferCopiedNodes()) {
                    event.preventDefault();
                    if (pasteCopiedNodes()) return;
                    void navigator.clipboard?.readText?.().then((text) => {
                        if (restoreCopiedNodesFromText(text)) pasteCopiedNodes();
                    }).catch(() => undefined);
                }
                return;
            }
            if (event.key === "Delete" || event.key === "Backspace") {
                // Backspace has a browser-level history action when it is not
                // consumed. Once the canvas handles deletion, do not let the
                // same key continue to other listeners or navigate away from
                // the project (which can look like the whole canvas vanished).
                event.preventDefault();
                event.stopPropagation();
                // A connection click can leave the connected node selected for
                // paint-order purposes. Treat the explicitly selected edge as
                // the primary target, otherwise Delete unexpectedly removes
                // the node instead of the edge the user just clicked.
                if (selectedConnectionId) deleteConnection(selectedConnectionId);
                else if (selectedNodeIdsRef.current.size) deleteNodes(new Set(selectedNodeIdsRef.current));
                return;
            }
            if (event.key === "Escape") {
                // 沉浸专注：无选中且无弹窗/下拉/右键菜单时，Esc 退出专注；否则保留原有取消选择行为。
                const hasFocusOverlay = Boolean(document.querySelector(".ant-modal-wrap, .ant-dropdown, .ant-select-dropdown, .ant-popover, [data-canvas-context-menu]"));
                if (focusMode && !selectedNodeIdsRef.current.size && !hasFocusOverlay) {
                    event.stopPropagation();
                    exitFocusMode();
                    return;
                }
                deselectCanvas();
                setInfoNodeId(null);
                setCropNodeId(null);
                setMaskEditNodeId(null);
                setAnnotationNodeId(null);
            }
        };

        const handlePaste = (event: ClipboardEvent) => {
            const target = event.target instanceof Element ? event.target : null;
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || target?.closest("[contenteditable='true']")) return;
            // 节点标记写入失败或仍在写入时避开旧系统图片，其余情况保持系统内容优先。
            event.preventDefault();
            const text = event.clipboardData?.getData("text/plain") || "";
            if (text && restoreCopiedNodesFromText(text) && pasteCopiedNodes()) return;
            if (shouldPreferCopiedNodes() && pasteCopiedNodes()) return;
            void (async () => {
                const handled = await pasteSystemClipboard(undefined, event);
                if (!handled) pasteCopiedNodes();
            })();
        };

        window.addEventListener("keydown", handleKeyDown, true);
        window.addEventListener("paste", handlePaste, true);
        return () => {
            window.removeEventListener("keydown", handleKeyDown, true);
            window.removeEventListener("paste", handlePaste, true);
        };
    }, [enabled, autoArrangeCanvasNodes, beginBatchConnection, cancelSelectionBox, copySelectedNodes, deleteConnection, deleteNodes, deselectCanvas, exitFocusMode, fitCanvasContent, fitCanvasSelection, focusMode, nodesRef, onOpenSearch, onToggleAssistant, pasteCopiedNodes, pasteSystemClipboard, redoCanvas, restoreCopiedNodesFromText, saveCanvasProject, selectedConnectionId, selectedNodeIdsRef, setAnnotationNodeId, setContextMenu, setCropNodeId, setInfoNodeId, setMaskEditNodeId, setSelectedConnectionId, setSelectedNodeIds, setShortcutRequestNonce, shouldPreferCopiedNodes, toggleFocusMode, undoCanvas, zoomCanvasIn, zoomCanvasOut, zoomToActualSize]);
}
