import { CanvasNodeType, type CanvasNodeTypeId } from "@/types/canvas";

/** Features intentionally shown for roadmap visibility but not released yet. */
export const CANVAS_DEVELOPING_LABEL = "正在开发";

const developingNodeTypes = new Set<CanvasNodeTypeId>([
    CanvasNodeType.MediaConversion,
    CanvasNodeType.Frame,
    CanvasNodeType.Script,
]);

export function getCanvasNodeCreationDisabledReason(type: CanvasNodeTypeId) {
    return developingNodeTypes.has(type) ? CANVAS_DEVELOPING_LABEL : undefined;
}

export function isCanvasNodeCreationEnabled(type: CanvasNodeTypeId) {
    return !getCanvasNodeCreationDisabledReason(type);
}
