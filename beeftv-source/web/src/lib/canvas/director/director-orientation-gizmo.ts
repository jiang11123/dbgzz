import { Matrix4, Quaternion, Vector3 } from "three";
import type { DirectorViewMode } from "@/lib/canvas/director/director-view-modes";

export type DirectorOrientation = [number, number, number, number];
export type DirectorAxisHead = { id: string; label: string; mode?: DirectorViewMode; x: number; y: number; depth: number };

const axes: Array<{ id: string; label: string; mode?: DirectorViewMode; direction: [number, number, number] }> = [
    { id: "x+", label: "右视", mode: "right", direction: [1, 0, 0] },
    { id: "x-", label: "左视", mode: "left", direction: [-1, 0, 0] },
    { id: "y+", label: "俯视", mode: "top", direction: [0, 1, 0] },
    { id: "y-", label: "下方", direction: [0, -1, 0] },
    { id: "z+", label: "正视", mode: "front", direction: [0, 0, 1] },
    { id: "z-", label: "背视", mode: "back", direction: [0, 0, -1] },
];

/** Project world axes into the active camera's screen plane. */
export function directorAxisHeads(orientation: DirectorOrientation): DirectorAxisHead[] {
    const inverse = new Quaternion(...orientation).invert();
    return axes.map(({ id, label, mode, direction }) => {
        const projected = new Vector3(...direction).applyQuaternion(inverse);
        return { id, label, mode, x: 36 + projected.x * 24, y: 36 - projected.y * 24, depth: projected.z };
    }).sort((a, b) => a.depth - b.depth);
}

export function directorOrientationForMode(mode: DirectorViewMode, free: DirectorOrientation): DirectorOrientation {
    const eye: Partial<Record<DirectorViewMode, [number, number, number]>> = {
        top: [0, 10, 0], front: [0, 0, 10], back: [0, 0, -10], left: [-10, 0, 0], right: [10, 0, 0],
    };
    const position = eye[mode];
    if (!position) return free;
    const up = mode === "top" ? new Vector3(0, 0, -1) : new Vector3(0, 1, 0);
    const q = new Quaternion().setFromRotationMatrix(new Matrix4().lookAt(new Vector3(...position), new Vector3(), up));
    return [q.x, q.y, q.z, q.w];
}
