import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";

import { updateCanvasNode, updateCanvasNodes } from "@/lib/canvas/canvas-node-timestamps";
import { repairOverlappingImageBatches } from "@/lib/canvas/canvas-generation-layout";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";

export const MEDIA_NODE_CONTENT_FLUSH_MS = 120;

export function queueMediaNodeContentUpdate(
    pending: Map<string, (node: CanvasNodeData) => CanvasNodeData>,
    nodeId: string,
    update: (node: CanvasNodeData) => CanvasNodeData,
) {
    const previous = pending.get(nodeId);
    pending.set(nodeId, previous ? (node) => update(previous(node)) : update);
}

type UseCanvasNodeContentOptions = {
    nodesRef: { current: CanvasNodeData[] };
    setNodesState: Dispatch<SetStateAction<CanvasNodeData[]>>;
};

export function useCanvasNodeContent({ nodesRef, setNodesState }: UseCanvasNodeContentOptions) {
    const pendingMediaUpdatesRef = useRef(new Map<string, (node: CanvasNodeData) => CanvasNodeData>());
    const mediaUpdateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const updateNodeFromContent = useCallback((nodeId: string, update: (node: CanvasNodeData) => CanvasNodeData) => {
        setNodesState((current) => {
            const next = updateCanvasNode(current, nodeId, update);
            nodesRef.current = next;
            return next;
        });
    }, [nodesRef, setNodesState]);

    const updateMediaNodeFromContent = useCallback((nodeId: string, update: (node: CanvasNodeData) => CanvasNodeData) => {
        queueMediaNodeContentUpdate(pendingMediaUpdatesRef.current, nodeId, update);
        if (mediaUpdateTimerRef.current) return;
        mediaUpdateTimerRef.current = setTimeout(() => {
            const updates = pendingMediaUpdatesRef.current;
            pendingMediaUpdatesRef.current = new Map();
            mediaUpdateTimerRef.current = null;
            if (!updates.size) return;
            setNodesState((current) => {
                const next = repairOverlappingImageBatches(updateCanvasNodes(current, updates));
                nodesRef.current = next;
                return next;
            });
        }, MEDIA_NODE_CONTENT_FLUSH_MS);
    }, [nodesRef, setNodesState]);

    useEffect(() => () => {
        if (mediaUpdateTimerRef.current) clearTimeout(mediaUpdateTimerRef.current);
    }, []);

    const updateNodeMetadataFromContent = useCallback(
        (nodeId: string, patch: CanvasNodeMetadata) => {
            updateNodeFromContent(nodeId, (node) => ({ ...node, metadata: { ...node.metadata, ...patch } }));
        },
        [updateNodeFromContent],
    );

    return {
        updateNodeFromContent,
        updateMediaNodeFromContent,
        updateNodeMetadataFromContent,
    };
}
