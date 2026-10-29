import type { Dispatch, SetStateAction } from "react";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";

/** Publish to the editor before the store can trigger an autosave or leave flush. */
export function projectCanvasGenerationSubmission(
    nodesRef: { current: CanvasNodeData[] },
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>,
    nodeIds: string[],
    metadata: CanvasNodeMetadata,
) {
    const ids = new Set(nodeIds);
    const next = nodesRef.current.map(node => ids.has(node.id) ? { ...node, metadata: { ...node.metadata, ...metadata } } : node);
    nodesRef.current = next;
    setNodes(next);
}

/** Apply an attempt's output state without reverting edits made while it prepared. */
export function rebaseCanvasGenerationTarget(live: CanvasNodeData, planned: CanvasNodeData, captured: CanvasNodeData | undefined): CanvasNodeData {
    const metadata = { ...live.metadata, ...planned.metadata };
    // Copied snapshot fields are not new writes. Keep newer live output or
    // configuration, while this attempt still owns its loading state.
    for (const key of Object.keys(planned.metadata || {}) as Array<keyof NonNullable<CanvasNodeData["metadata"]>>) {
        if (key !== "status" && Object.hasOwn(captured?.metadata || {}, key)
            && JSON.stringify(planned.metadata?.[key]) === JSON.stringify(captured?.metadata?.[key])) {
            if (Object.hasOwn(live.metadata || {}, key)) Object.assign(metadata, { [key]: live.metadata?.[key] });
            else delete metadata[key];
        }
    }
    // The attempt deliberately clears the previous output/task. A spread alone
    // restores those deleted keys; delete only when the live value is still the
    // captured one, so preparation cannot erase a newer edit or result.
    for (const key of Object.keys(captured?.metadata || {}) as Array<keyof NonNullable<CanvasNodeData["metadata"]>>) {
        if (!Object.hasOwn(planned.metadata || {}, key)
            && JSON.stringify(live.metadata?.[key]) === JSON.stringify(captured?.metadata?.[key])) delete metadata[key];
    }
    for (const key of ["prompt", "composerContent"] as const) {
        if (live.metadata?.[key] !== captured?.metadata?.[key]) metadata[key] = live.metadata?.[key];
    }
    return { ...live, metadata };
}
