import { CanvasNodeType, type CanvasNodeData, type Position } from "@/types/canvas";
import { canvasMediaNodeOrigin, canvasMediaNodeRole } from "@/lib/canvas/canvas-node-semantics";

type Size = {
    width: number;
    height: number;
};

const BATCH_CHILD_OFFSET_X = 120;
const BATCH_CHILD_GAP = 36;
const BATCH_ROW_GAP = 84;
const NODE_CLEARANCE = 36;

export function canGenerateImageInPlace(sourceNode: CanvasNodeData | undefined) {
    return canGenerateMediaInPlace(sourceNode, CanvasNodeType.Image);
}

export function canGenerateMediaInPlace(sourceNode: CanvasNodeData | undefined, mediaType: typeof CanvasNodeType.Image | typeof CanvasNodeType.Video | typeof CanvasNodeType.Audio) {
    if (sourceNode?.type !== mediaType) return false;
    if (sourceNode.metadata?.generationResultPlacement) return sourceNode.metadata.generationResultPlacement === "replace-node";
    if (!sourceNode.metadata?.content) return true;
    if (canvasMediaNodeRole(sourceNode) === "generator") return true;
    if (canvasMediaNodeOrigin(sourceNode) === "generated" && Boolean((sourceNode.metadata?.composerContent || sourceNode.metadata?.prompt)?.trim())) return true;
    // 兼容显式落点字段引入前创建的复制节点和版本节点。
    return Boolean(sourceNode.metadata?.copiedFromNodeId || sourceNode.metadata?.versionOfNodeId);
}

export function canGenerateTextInPlace(sourceNode: CanvasNodeData | undefined) {
    return sourceNode?.type === CanvasNodeType.Text;
}

export function planTextGenerationTargets(input: {
    nodeId: string;
    sourceNode: CanvasNodeData | undefined;
    isConfigNode: boolean;
    count: number;
    createId: () => string;
}) {
    const generateInPlace = !input.isConfigNode && canGenerateTextInPlace(input.sourceNode);
    const childIds = Array.from({ length: generateInPlace ? Math.max(0, input.count - 1) : input.count }, input.createId);
    return {
        generateInPlace,
        childIds,
        targetIds: generateInPlace ? [input.nodeId, ...childIds] : childIds,
    };
}

export function generationFailureNodeStatus(hasPreviousResult: boolean) {
    return hasPreviousResult ? "success" as const : "error" as const;
}

export function imageGenerationGroupSize(rootSize: Size, imageSize: Size, childCount: number): Size {
    if (childCount <= 0) return rootSize;
    const columns = Math.min(childCount, 2);
    const rows = Math.ceil(childCount / 2);
    return {
        width: rootSize.width + BATCH_CHILD_OFFSET_X + columns * imageSize.width + (columns - 1) * BATCH_CHILD_GAP,
        height: Math.max(rootSize.height, rows * imageSize.height + (rows - 1) * BATCH_ROW_GAP),
    };
}

export function imageGenerationChildPosition(rootPosition: Position, rootWidth: number, imageSize: Size, index: number): Position {
    return {
        x: rootPosition.x + rootWidth + BATCH_CHILD_OFFSET_X + (index % 2) * (imageSize.width + BATCH_CHILD_GAP),
        y: rootPosition.y + Math.floor(index / 2) * (imageSize.height + BATCH_ROW_GAP),
    };
}

export function repairOverlappingImageBatches(nodes: CanvasNodeData[]): CanvasNodeData[] {
    let result = nodes;
    const nodeById = new Map(nodes.map(node => [node.id, node]));
    for (const root of nodes) {
        if (!root.metadata?.isBatchRoot) continue;
        const children = (root.metadata.batchChildIds || []).map(id => nodeById.get(id)).filter((node): node is CanvasNodeData => Boolean(node && node.metadata?.batchRootId === root.id));
        const group = [root, ...children];
        if (!children.length || group.some(node => node.metadata?.locked || node.metadata?.workflowSlot)) continue;
        const overlaps = group.some((node, i) => group.slice(i + 1).some(other => (
            node.position.x < other.position.x + other.width - 1 && node.position.x + node.width > other.position.x + 1
            && node.position.y < other.position.y + other.height - 1 && node.position.y + node.height > other.position.y + 1
        )));
        if (!overlaps) continue;

        const columnWidth = Math.max(...children.filter((_, i) => i % 2 === 0).map(node => node.width));
        const positions = new Map<string, Position>();
        let rowY = 0;
        for (let i = 0; i < children.length; i += 2) {
            const row = children.slice(i, i + 2);
            row.forEach((node, col) => positions.set(node.id, { x: root.width + BATCH_CHILD_OFFSET_X + col * (columnWidth + BATCH_CHILD_GAP), y: rowY }));
            rowY += Math.max(...row.map(node => node.height)) + BATCH_ROW_GAP;
        }
        const groupIds = new Set(group.map(node => node.id));
        const groupSize = {
            width: Math.max(root.width, ...children.map(node => positions.get(node.id)!.x + node.width)),
            height: Math.max(root.height, rowY - BATCH_ROW_GAP),
        };
        const origin = root.metadata.imageBatchExpanded
            ? findAvailableGenerationGroupPosition(result.filter(node => !groupIds.has(node.id) && (!node.metadata?.batchRootId || nodeById.get(node.metadata.batchRootId)?.metadata?.imageBatchExpanded)), root.position, groupSize)
            : root.position;
        result = result.map(node => {
            const offset = positions.get(node.id);
            if (node.id === root.id) return origin.x === node.position.x && origin.y === node.position.y ? node : { ...node, position: origin };
            return offset ? { ...node, position: { x: origin.x + offset.x, y: origin.y + offset.y } } : node;
        });
    }
    return result;
}

export function findAvailableGenerationGroupPosition(nodes: CanvasNodeData[], preferred: Position, groupSize: Size): Position {
    const down = resolveCollisions(nodes, preferred, groupSize, "down");
    const right = resolveCollisions(nodes, preferred, groupSize, "right");
    const downDistance = down.y - preferred.y;
    const rightDistance = right.x - preferred.x;
    return downDistance <= rightDistance ? down : right;
}

// 分别沿下方和右侧求出最近空位，再选择移动距离更短的方向，避免生成组覆盖已有节点。
function resolveCollisions(nodes: CanvasNodeData[], preferred: Position, groupSize: Size, direction: "down" | "right"): Position {
    const candidate = { ...preferred };
    for (let attempt = 0; attempt <= nodes.length; attempt += 1) {
        const collisions = nodes.filter((node) => rectanglesOverlap(candidate, groupSize, node.position, node));
        if (!collisions.length) return candidate;
        if (direction === "down") candidate.y = Math.max(...collisions.map((node) => node.position.y + node.height + NODE_CLEARANCE));
        else candidate.x = Math.max(...collisions.map((node) => node.position.x + node.width + NODE_CLEARANCE));
    }
    return candidate;
}

function rectanglesOverlap(firstPosition: Position, firstSize: Size, secondPosition: Position, secondSize: Size) {
    return !(
        firstPosition.x + firstSize.width + NODE_CLEARANCE <= secondPosition.x ||
        firstPosition.x >= secondPosition.x + secondSize.width + NODE_CLEARANCE ||
        firstPosition.y + firstSize.height + NODE_CLEARANCE <= secondPosition.y ||
        firstPosition.y >= secondPosition.y + secondSize.height + NODE_CLEARANCE
    );
}
