import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";

import type { CanvasNodeData, ContextMenuState } from "@/types/canvas";

import { canvasNodeDragEndChrome, canvasNodeInteractionStartChrome } from "./canvas-pointer-chrome";

type UseCanvasPointerSelectionChromeOptions = {
    nodesRef: { current: CanvasNodeData[] };
    segmentRunningMode?: string | null;
    setContextMenu: Dispatch<SetStateAction<ContextMenuState | null>>;
    setHoveredNodeId: Dispatch<SetStateAction<string | null>>;
    setToolbarNodeId: Dispatch<SetStateAction<string | null>>;
    setDialogNodeId: Dispatch<SetStateAction<string | null>>;
};

export function useCanvasPointerSelectionChrome({
    nodesRef,
    segmentRunningMode,
    setContextMenu,
    setHoveredNodeId,
    setToolbarNodeId,
    setDialogNodeId,
}: UseCanvasPointerSelectionChromeOptions) {
    const handleCanvasSelectionStart = useCallback(() => {
        setContextMenu(null);
    }, [setContextMenu]);

    const handleNodeInteractionStart = useCallback((selectionModifier: boolean) => {
        setContextMenu(null);
        setHoveredNodeId(null);
        // Keep the source node's extraction state visible while FFmpeg is
        // producing the independent video/audio outputs.
        const chrome = canvasNodeInteractionStartChrome({
            segmentRunningAudio: segmentRunningMode === "audio",
            selectionModifier,
        });
        if (chrome.ignore) return;
        setToolbarNodeId(null);
        if (chrome.closeDialog) setDialogNodeId(null);
    }, [segmentRunningMode, setContextMenu, setDialogNodeId, setHoveredNodeId, setToolbarNodeId]);

    const handleNodeDragEnd = useCallback(
        (nodeId: string) => {
            const chrome = canvasNodeDragEndChrome(nodesRef.current.find((item) => item.id === nodeId));
            setDialogNodeId(chrome.dialogNodeId);
            if (chrome.toolbarNodeId) setToolbarNodeId(chrome.toolbarNodeId);
        },
        [nodesRef, setDialogNodeId, setToolbarNodeId],
    );

    const handleCanvasDeselect = useCallback(() => {
        setContextMenu(null);
        setHoveredNodeId(null);
        setToolbarNodeId(null);
        setDialogNodeId(null);
    }, [setContextMenu, setDialogNodeId, setHoveredNodeId, setToolbarNodeId]);

    return {
        handleCanvasSelectionStart,
        handleNodeInteractionStart,
        handleNodeDragEnd,
        handleCanvasDeselect,
    };
}

type UseCanvasNodeToolbarHoverOptions = {
    nodeDraggingRef: { current: boolean };
    nodeImageSettingsOpen: boolean;
    setHoveredNodeId: Dispatch<SetStateAction<string | null>>;
    setToolbarNodeId: Dispatch<SetStateAction<string | null>>;
};

export function useCanvasNodeToolbarHover({
    nodeDraggingRef,
    nodeImageSettingsOpen,
    setHoveredNodeId,
    setToolbarNodeId,
}: UseCanvasNodeToolbarHoverOptions) {
    const toolbarHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const keepNodeToolbar = useCallback(
        (nodeId: string) => {
            if (nodeDraggingRef.current || nodeImageSettingsOpen) return;
            if (toolbarHideTimerRef.current) {
                clearTimeout(toolbarHideTimerRef.current);
                toolbarHideTimerRef.current = null;
            }
            setToolbarNodeId(nodeId);
        },
        [nodeDraggingRef, nodeImageSettingsOpen, setToolbarNodeId],
    );

    const hideNodeToolbar = useCallback(() => {
        if (toolbarHideTimerRef.current) clearTimeout(toolbarHideTimerRef.current);
        toolbarHideTimerRef.current = setTimeout(() => {
            setToolbarNodeId(null);
            toolbarHideTimerRef.current = null;
        }, 120);
    }, [setToolbarNodeId]);

    useEffect(() => () => {
        if (toolbarHideTimerRef.current) clearTimeout(toolbarHideTimerRef.current);
    }, []);

    const handleCanvasNodeHoverStart = useCallback(
        (nodeId: string) => {
            if (nodeDraggingRef.current) return;
            setHoveredNodeId(nodeId);
            keepNodeToolbar(nodeId);
        },
        [keepNodeToolbar, nodeDraggingRef, setHoveredNodeId],
    );

    const handleCanvasNodeHoverEnd = useCallback(
        (nodeId: string) => {
            setHoveredNodeId((current) => (current === nodeId ? null : current));
            hideNodeToolbar();
        },
        [hideNodeToolbar, setHoveredNodeId],
    );

    return {
        keepNodeToolbar,
        hideNodeToolbar,
        handleCanvasNodeHoverStart,
        handleCanvasNodeHoverEnd,
    };
}
