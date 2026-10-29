import type { CanvasConnection, Position } from "@/types/canvas";

export function resolveDirectorOutputPositions(input: {
    source: { position: Position; width: number };
    previewSize: { width: number; height: number };
    existingPreviewPosition?: Position;
    existingVideoPosition?: Position;
}) {
    const gap = 48;
    const rightX = input.source.position.x + input.source.width + gap;
    const previewPosition = input.existingPreviewPosition && input.existingPreviewPosition.x >= rightX
        ? input.existingPreviewPosition
        : { x: rightX, y: input.source.position.y };
    const videoPosition = input.existingVideoPosition && input.existingVideoPosition.x >= rightX
        ? input.existingVideoPosition
        : { x: rightX, y: previewPosition.y + input.previewSize.height + gap };
    return { previewPosition, videoPosition };
}

export function ensureDirectorOutputConnections(connections: CanvasConnection[], sourceId: string, outputIds: string[], createId: () => string) {
    const outputs = new Set(outputIds.filter((id) => id && id !== sourceId));
    const retained: CanvasConnection[] = [];
    const connected = new Set<string>();

    for (const connection of connections) {
        const isOutputTarget = connection.fromNodeId === sourceId && outputs.has(connection.toNodeId);
        const isLegacyReverseOutput = outputs.has(connection.fromNodeId) && connection.toNodeId === sourceId;
        if (isLegacyReverseOutput) continue;
        if (isOutputTarget) {
            if (connected.has(connection.toNodeId)) continue;
            connected.add(connection.toNodeId);
        }
        retained.push(connection);
    }

    for (const outputId of outputs) {
        if (connected.has(outputId)) continue;
        retained.push({ id: createId(), fromNodeId: sourceId, toNodeId: outputId });
    }
    return retained;
}
