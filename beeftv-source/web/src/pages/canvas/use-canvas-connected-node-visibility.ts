import { useCallback, type Dispatch, type SetStateAction } from "react";

import type { CanvasConnection, CanvasNodeData, ViewportTransform } from "@/types/canvas";

import { connectedNodeVisibleViewport } from "./canvas-viewport-safe-area";

type UseCanvasConnectedNodeVisibilityOptions = {
    size: { width: number; height: number };
    containerRef: { current: HTMLDivElement | null };
    viewportRef: { current: ViewportTransform };
    nodesRef: { current: CanvasNodeData[] };
    connectionsRef: { current: CanvasConnection[] };
    setViewport: Dispatch<SetStateAction<ViewportTransform>>;
};

export function useCanvasConnectedNodeVisibility({
    size,
    containerRef,
    viewportRef,
    nodesRef,
    connectionsRef,
    setViewport,
}: UseCanvasConnectedNodeVisibilityOptions) {
    return useCallback((node: CanvasNodeData, sourceNodeId?: string) => {
        const canvasWidth = size.width || containerRef.current?.clientWidth || 0;
        const canvasHeight = size.height || containerRef.current?.clientHeight || 0;
        const next = connectedNodeVisibleViewport({
            node,
            sourceNodeId,
            nodes: nodesRef.current,
            connections: connectionsRef.current,
            viewport: viewportRef.current,
            canvasWidth,
            canvasHeight,
        });
        if (!next) return;
        viewportRef.current = next;
        setViewport(next);
    }, [connectionsRef, containerRef, nodesRef, setViewport, size.height, size.width, viewportRef]);
}
