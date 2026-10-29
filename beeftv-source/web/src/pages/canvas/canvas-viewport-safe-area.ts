import type { CanvasConnection, CanvasNodeData, ViewportTransform } from "@/types/canvas";

export type ConnectedNodeVisibleViewportInput = {
    node: CanvasNodeData;
    sourceNodeId?: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    viewport: ViewportTransform;
    canvasWidth: number;
    canvasHeight: number;
};

/**
 * Pan (and only pan/scale) the viewport so a newly connected node stays inside
 * the visible canvas safe area. Node world positions stay unchanged.
 */
export function connectedNodeVisibleViewport(input: ConnectedNodeVisibleViewportInput): ViewportTransform | null {
    if (input.canvasWidth <= 0) return null;
    const current = input.viewport;
    const scale = Math.max(current.k, 0.05);
    const source = input.nodes.find((candidate) => candidate.id === input.sourceNodeId && candidate.id !== input.node.id)
        || input.nodes
            .filter((candidate) => candidate.id !== input.node.id && candidate.position.x + candidate.width <= input.node.position.x + 180)
            .sort((a, b) => Math.abs((a.position.y + a.height / 2) - (input.node.position.y + input.node.height / 2)) - Math.abs((b.position.y + b.height / 2) - (input.node.position.y + input.node.height / 2)))[0];
    const relatedIds = new Set<string>([input.node.id, ...(source ? [source.id] : [])]);
    if (source) {
        input.connections.forEach((connection) => {
            if (connection.fromNodeId === source.id) relatedIds.add(connection.toNodeId);
            if (connection.toNodeId === source.id) relatedIds.add(connection.fromNodeId);
        });
    }
    const visibleNodes = [input.node, ...input.nodes.filter((candidate) => relatedIds.has(candidate.id) && candidate.id !== input.node.id)];
    const leftWorld = Math.min(...visibleNodes.map((item) => item.position.x));
    const rightWorld = Math.max(...visibleNodes.map((item) => item.position.x + item.width));
    const topWorld = Math.min(...visibleNodes.map((item) => item.position.y));
    const bottomWorld = Math.max(...visibleNodes.map((item) => item.position.y + item.height));
    const safeLeft = 24;
    const safeRight = input.canvasWidth - 24;
    const safeTop = 64;
    const safeBottom = Math.max(safeTop + 1, input.canvasHeight - 72);
    const worldWidth = Math.max(1, rightWorld - leftWorld);
    const worldHeight = Math.max(1, bottomWorld - topWorld);
    const availableWidth = Math.max(1, safeRight - safeLeft);
    const availableHeight = Math.max(1, safeBottom - safeTop);
    const nextScale = Math.max(0.35, Math.min(scale, availableWidth / worldWidth, availableHeight / worldHeight));
    const centerX = (safeLeft + safeRight) / 2;
    const centerY = (safeTop + safeBottom) / 2;
    const next = {
        x: centerX - ((leftWorld + rightWorld) / 2) * nextScale,
        y: centerY - ((topWorld + bottomWorld) / 2) * nextScale,
        k: nextScale,
    };
    if (Math.abs(next.x - current.x) < 1 && Math.abs(next.y - current.y) < 1 && Math.abs(next.k - current.k) < 0.01) return null;
    return next;
}
