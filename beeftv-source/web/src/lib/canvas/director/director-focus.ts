import type { DirectorVec3 } from "@/types/director";

export type DirectorFocusFrameInput = {
    cameraPosition: DirectorVec3;
    cameraTarget: DirectorVec3;
    focusTarget: DirectorVec3;
    radius: number;
    fov: number;
};

export type DirectorFocusFrame = { position: DirectorVec3; target: DirectorVec3 };

/** Reframe the free editor camera around one scene asset without changing scene data or history. */
export function resolveDirectorFocusFrame(input: DirectorFocusFrameInput): DirectorFocusFrame | null {
    const values = [...input.cameraPosition, ...input.cameraTarget, ...input.focusTarget];
    if (!values.every(Number.isFinite) || !Number.isFinite(input.radius)) return null;

    let direction = input.cameraPosition.map((value, index) => value - input.cameraTarget[index]) as DirectorVec3;
    let distance = Math.hypot(...direction);
    if (distance < 1e-5) {
        direction = [0, 0, 1];
        distance = 1;
    }
    direction = direction.map((value) => value / distance) as DirectorVec3;

    const fov = Math.min(120, Math.max(10, Number.isFinite(input.fov) ? input.fov : 50)) * Math.PI / 180;
    const radius = Math.min(1000, Math.max(0.1, Math.abs(input.radius)));
    const framedDistance = Math.min(80, Math.max(1.25, radius / Math.sin(fov / 2) * 1.15));
    const target = [...input.focusTarget] as DirectorVec3;
    const position = target.map((value, index) => value + direction[index] * framedDistance) as DirectorVec3;
    return { position, target };
}
