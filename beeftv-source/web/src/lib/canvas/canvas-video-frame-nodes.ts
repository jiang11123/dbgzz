import { nanoid } from "nanoid";

import { imageMetadata } from "@/lib/canvas/canvas-generation-task-sync";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { mediaResultMetadata } from "@/lib/canvas/canvas-node-semantics";
import { formatVideoFrameTime } from "@/lib/canvas/canvas-video-frame";
import type { UploadedImage } from "@/services/image-storage";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

type UploadedVideoFrame = {
    timeMs: number;
    image: UploadedImage;
};

const FRAME_NODE_GAP = 24;
const FRAME_NODE_OFFSET = 96;
const FRAME_GRID_MAX_COLUMNS = 3;

export function buildVideoFrameNodes(source: CanvasNodeData, frames: UploadedVideoFrame[], existingNodes: CanvasNodeData[] = []): CanvasNodeData[] {
    if (!frames.length) return [];
    const sizes = frames.map(({ image }) => fitNodeSize(image.width, image.height, source.width, source.height));
    const cellWidth = Math.max(...sizes.map((size) => size.width));
    const cellHeight = Math.max(...sizes.map((size) => size.height));
    const columns = Math.min(FRAME_GRID_MAX_COLUMNS, Math.max(1, Math.ceil(Math.sqrt(frames.length))));
    const startX = source.position.x + source.width + FRAME_NODE_OFFSET;
    let startY = source.position.y;
    const priorFrames = existingNodes.filter((node) => node.metadata?.videoFrameSourceNodeId === source.id);
    const rows = Math.ceil(frames.length / columns);
    const groupWidth = columns * cellWidth + (columns - 1) * FRAME_NODE_GAP;
    const groupHeight = rows * cellHeight + (rows - 1) * FRAME_NODE_GAP;
    while (priorFrames.some((node) => rectanglesOverlap(
        { x: startX, y: startY, width: groupWidth, height: groupHeight },
        { x: node.position.x, y: node.position.y, width: node.width, height: node.height },
    ))) {
        startY += cellHeight + FRAME_NODE_GAP;
    }

    return frames.map(({ timeMs, image }, index) => {
        const size = sizes[index];
        const column = index % columns;
        const row = Math.floor(index / columns);
        return {
            id: nanoid(),
            type: CanvasNodeType.Image,
            title: `截图 ${formatVideoFrameTime(timeMs)} · ${source.title || "视频"}`,
            position: {
                x: startX + column * (cellWidth + FRAME_NODE_GAP) + (cellWidth - size.width) / 2,
                y: startY + row * (cellHeight + FRAME_NODE_GAP) + (cellHeight - size.height) / 2,
            },
            width: size.width,
            height: size.height,
            metadata: mediaResultMetadata("derived", {
                ...imageMetadata(image),
                prompt: source.metadata?.prompt,
                workflowKind: source.metadata?.workflowKind,
                workflowTitle: source.metadata?.workflowTitle,
                shotIndex: source.metadata?.shotIndex,
                videoFrameSourceNodeId: source.id,
                videoFrameTimeMs: timeMs,
            }),
        } satisfies CanvasNodeData;
    });
}

function rectanglesOverlap(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) {
    return a.x < b.x + b.width
        && a.x + a.width > b.x
        && a.y < b.y + b.height
        && a.y + a.height > b.y;
}
