import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

/** Returns the first available positive index for a new director card. */
export function nextDirectorNodeIndex(nodes: CanvasNodeData[]): number {
    const used = new Set<number>();
    for (const node of nodes) {
        if (node.type !== CanvasNodeType.Director && !node.metadata?.directorSceneId) continue;
        const titleIndex = /^导演台(?:\s+(\d+))?$/.exec(node.title)?.[1];
        const index = Number(titleIndex || node.metadata?.shotIndex || 1);
        if (Number.isSafeInteger(index) && index > 0) used.add(index);
    }
    let candidate = 1;
    while (used.has(candidate)) candidate += 1;
    return candidate;
}
