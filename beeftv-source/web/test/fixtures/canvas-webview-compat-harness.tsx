import { useState } from "react";
import { createRoot } from "react-dom/client";

import { CanvasNodeSearchModal } from "@/components/canvas/canvas-node-search-modal";
import { searchCanvasNodes } from "@/lib/canvas/canvas-node-search";
import { createDirectorCamera, directorTransformPathLength, upsertDirectorBoneKeyframe, upsertDirectorKeyframe } from "@/lib/canvas/director/director-scene";
import { resolveDirectorCameraTrackValues } from "@/lib/canvas/director/director-view-modes";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { DirectorKeyframe, DirectorTransform } from "@/types/director";

const nodes: CanvasNodeData[] = [
    { id: "older", type: CanvasNodeType.Text, title: "Older note", position: { x: 0, y: 0 }, width: 200, height: 100, updatedAt: "2026-08-01T00:00:00Z", metadata: { content: "night scene" } },
    { id: "newer", type: CanvasNodeType.Text, title: "Newer note", position: { x: 0, y: 0 }, width: 200, height: 100, updatedAt: "2026-08-02T00:00:00Z", metadata: { content: "day scene" } },
];
Object.freeze(nodes);
const transform: DirectorTransform = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
const keys: DirectorKeyframe[] = [
    { id: "end", time: 2, transform: { ...transform, position: [6, 0, 0] }, target: [4, 0, 0], fov: 60 },
    { id: "start", time: 0, transform, target: [0, 0, 0], fov: 40 },
];
Object.freeze(keys);
const boneKeys = [{ id: "bone-end", time: 2, rotation: [0, 0, 0, 1] as [number, number, number, number] }];
Object.freeze(boneKeys);
const checks = {
    sorted: searchCanvasNodes(nodes, "").map((node) => node.id),
    original: nodes.map((node) => node.id),
    inserted: upsertDirectorKeyframe(keys, 1, transform).map((key) => key.time),
    updated: upsertDirectorKeyframe(keys, 2, transform).map((key) => key.time),
    bones: upsertDirectorBoneKeyframe([{ bone: "hips", keyframes: boneKeys }], "hips", 0, [0, 0, 0, 1])[0].keyframes.map((key) => key.time),
    boneUpdated: upsertDirectorBoneKeyframe([{ bone: "hips", keyframes: boneKeys }], "hips", 2, [0, 1, 0, 0])[0].keyframes.map((key) => key.time),
    length: directorTransformPathLength(keys),
    camera: resolveDirectorCameraTrackValues({ ...createDirectorCamera(), keyframes: keys }, 1),
    originalKeys: keys.map((key) => key.time),
    originalBoneKeys: boneKeys.map((key) => key.time),
};

function Harness() {
    const [open, setOpen] = useState(false);
    const [focused, setFocused] = useState("");
    const initialNodes = new URLSearchParams(location.search).has("empty") ? [] : nodes;
    return <>
        <div data-testid="canvas-ready">Canvas ready</div>
        <output data-testid="checks">{JSON.stringify(checks)}</output>
        <output data-testid="focused">{focused}</output>
        <button onClick={() => setOpen(true)}>Search nodes</button>
        <CanvasNodeSearchModal open={open} nodes={initialNodes} onClose={() => setOpen(false)} onFocus={setFocused} />
    </>;
}

createRoot(document.getElementById("root")!).render(<Harness />);
