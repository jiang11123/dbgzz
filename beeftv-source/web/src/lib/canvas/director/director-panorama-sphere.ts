import type { Object3D } from "three";

import type { DirectorScene } from "@/types/director";

export const DIRECTOR_PANORAMA_DEFAULT_RADIUS = 60;

export function directorPanoramaSphere(scene: DirectorScene) {
    return {
        radius: scene.panoramaRadius ?? DIRECTOR_PANORAMA_DEFAULT_RADIUS,
        rotation: scene.panoramaRotation ?? scene.panorama?.rotation ?? 0,
    };
}

/** Hide the colored sphere for non-beauty passes; the fallback background remains. */
export function suspendDirectorPanoramaSphere(scene: Object3D): () => void {
    const previous: Array<{ object: Object3D; visible: boolean }> = [];
    scene.traverse((object) => {
        if (object.userData.directorPanoramaSphere !== true) return;
        previous.push({ object, visible: object.visible });
        object.visible = false;
    });
    return () => { for (const item of previous) item.object.visible = item.visible; };
}
