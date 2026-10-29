import type { DirectorVec3 } from "@/types/director";

/** Keep the editor-only finder near the camera; the actual lens/FOV is unchanged. */
export function directorCameraAidDistance(targetDistance: number): number {
    return Math.min(1.2, Math.max(0.6, targetDistance * 0.1));
}

/** Nearby guides would cover the view, but a selected camera must retain its gizmo. */
export function directorCameraAidVisibility(selected: boolean, nearViewer: boolean) {
    return { body: selected || !nearViewer, guides: !nearViewer, gizmo: selected };
}

/** A missed pointer-up from a transform is not a request to deselect the camera. */
export function shouldClearDirectorViewportSelection(drawing: boolean, transformClaimed: boolean): boolean {
    return !drawing && !transformClaimed;
}

/** Editor-only viewfinder outline; the camera-to-corner rays obscure the stage. */
export function directorCameraFrameSegments(corners: readonly DirectorVec3[]): DirectorVec3[] {
    return corners.flatMap((corner, index) => [corner, corners[(index + 1) % corners.length]]);
}

/** LibTV 导演视角里的两条取景延长线；只从下角延伸，不穿过画面中心。 */
export function directorCameraGuideSegments(corners: readonly DirectorVec3[]): DirectorVec3[] {
    const height = corners[0][1] - corners[3][1];
    return [corners[3], [corners[3][0] * 0.93, corners[3][1] - height * 0.9, corners[3][2]],
        corners[2], [corners[2][0] * 0.93, corners[2][1] - height * 0.9, corners[2][2]]];
}
