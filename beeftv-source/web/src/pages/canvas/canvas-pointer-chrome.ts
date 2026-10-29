import { canOpenCanvasNodePromptPanel, isCanvasMediaResultNode } from "@/lib/canvas/canvas-node-semantics";
import type { CanvasNodeData } from "@/types/canvas";

export type CanvasNodeDragEndChrome = {
    dialogNodeId: string | null;
    toolbarNodeId?: string;
};

export function canvasNodeDragEndChrome(node: CanvasNodeData | undefined): CanvasNodeDragEndChrome {
    if (!node || !canOpenCanvasNodePromptPanel(node)) {
        return {
            dialogNodeId: null,
            toolbarNodeId: node && isCanvasMediaResultNode(node) ? node.id : undefined,
        };
    }
    // A drag selects a new node even though it is not a click. Keep the
    // generation editor bound to the node most recently moved.
    return { dialogNodeId: node.id };
}

export function canvasNodeInteractionStartChrome(input: { segmentRunningAudio: boolean; selectionModifier: boolean }) {
    if (input.segmentRunningAudio) return { ignore: true as const, closeToolbar: false, closeDialog: false };
    return { ignore: false as const, closeToolbar: true, closeDialog: input.selectionModifier };
}
