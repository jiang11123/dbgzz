import { expect, test } from "bun:test";
import { resetInterruptedGeneration } from "../src/lib/canvas/canvas-project-generation";
import { imageGenerationChildPosition, repairOverlappingImageBatches } from "../src/lib/canvas/canvas-generation-layout";
import { fitImageNodeToDecodedSize, nodeSizeFromRatio } from "../src/lib/canvas/canvas-node-size";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

function batch(width: number, height: number, strideX: number, strideY: number, count = 4): CanvasNodeData[] {
    const ids = Array.from({ length: count }, (_, i) => `child-${i}`);
    return [
        { id: "root", type: CanvasNodeType.Image, title: "root", position: { x: 0, y: 0 }, width, height, metadata: { isBatchRoot: true, batchChildIds: ids, imageBatchExpanded: true, content: "root.png" } },
        ...ids.map((id, i) => ({ id, type: CanvasNodeType.Image, title: id, position: { x: 390 + (i % 2) * strideX, y: Math.floor(i / 2) * strideY }, width, height, metadata: { batchRootId: "root", content: `${id}.png`, status: "success" as const } })),
    ];
}

function assertSeparated(nodes: CanvasNodeData[]) {
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i]!, b = nodes[j]!;
        expect(a.position.x + a.width <= b.position.x || b.position.x + b.width <= a.position.x || a.position.y + a.height <= b.position.y || b.position.y + b.height <= a.position.y).toBe(true);
    }
}

test("reopening repairs square batches enlarged after their placeholder layout", () => {
    const nodes = batch(520, 520, 456, 456, 8);
    const repaired = resetInterruptedGeneration(nodes);
    assertSeparated(repaired);
    expect(repaired.map(n => n.metadata?.content)).toEqual(nodes.map(n => n.metadata?.content));
    expect(resetInterruptedGeneration(repaired)).toBe(repaired);
});

test("reopening repairs 4:3 batches using actual node widths and row heights", () => {
    assertSeparated(resetInterruptedGeneration(batch(690.3448, 520, 573.6724, 441)));
});

for (const [width, height] of [[1024, 1024], [1456, 816], [816, 1456], [1232, 928], [928, 1232], [1344, 896], [896, 1344]]) {
    test(`${width}x${height}: decoded 1K/2K/4K images retain batch spacing for 4/8/12 outputs`, () => {
        const size = nodeSizeFromRatio(`${width}x${height}`, 720, 405)!;
        for (const count of [4, 8, 12]) for (const multiplier of [1, 2, 4]) {
            const nodes = batch(size.width, size.height, 0, 0, count);
            nodes.slice(1).forEach((node, i) => { node.position = imageGenerationChildPosition(nodes[0]!.position, nodes[0]!.width, size, i); });
            const loaded = nodes.map(node => fitImageNodeToDecodedSize(node, width * multiplier, height * multiplier));
            assertSeparated(loaded);
            loaded.forEach((node, i) => {
                expect(node.width).toBeCloseTo(nodes[i]!.width, 4);
                expect(node.height).toBeCloseTo(nodes[i]!.height, 4);
                expect(node.position).toEqual(nodes[i]!.position);
            });
            expect(repairOverlappingImageBatches(loaded)).toBe(loaded);
        }
    });
}

test("healthy 16:9 batches and manual layouts remain unchanged", () => {
    const nodes = batch(720, 405, 756, 441);
    nodes.slice(1).forEach((node, i) => { node.position = imageGenerationChildPosition(nodes[0]!.position, 720, node, i); });
    expect(resetInterruptedGeneration(nodes)).toBe(nodes);
    const manual = { ...nodes[1]!, width: 600, height: 600, metadata: { ...nodes[1]!.metadata, manualSize: true } };
    const decoded = fitImageNodeToDecodedSize(manual, 1024, 1024);
    expect([decoded.width, decoded.height]).toEqual([600, 600]);
});

test("mixed output dimensions use real column widths and row heights", () => {
    const nodes = batch(520, 520, 456, 456);
    nodes[1]!.height = 900;
    nodes[2]!.width = 700;
    nodes[3]!.width = 650;
    const repaired = repairOverlappingImageBatches(nodes);
    assertSeparated(repaired);
    expect(repaired.map(node => [node.width, node.height])).toEqual(nodes.map(node => [node.width, node.height]));
});

test("repair keeps a growing batch clear of neighbouring nodes", () => {
    const nodes = [...batch(520, 520, 456, 456), { ...batch(520, 520, 456, 456)[0]!, id: "neighbour", position: { x: 1400, y: 0 }, metadata: { content: "other.png" } }];
    const repaired = repairOverlappingImageBatches(nodes);
    assertSeparated(repaired);
    expect(repaired.at(-1)).toBe(nodes.at(-1));
});

test("locked and workflow-owned batches keep their existing geometry", () => {
    for (const metadata of [{ locked: true }, { workflowSlot: { slotId: "slot" } }]) {
        const nodes = batch(520, 520, 456, 456);
        nodes[0]!.metadata = { ...nodes[0]!.metadata, ...metadata } as CanvasNodeData["metadata"];
        expect(repairOverlappingImageBatches(nodes)).toBe(nodes);
    }
});
