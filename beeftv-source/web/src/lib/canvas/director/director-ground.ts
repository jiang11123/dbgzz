import type { DirectorScene } from "@/types/director";

export const DIRECTOR_DEFAULT_GROUND = { visible: true, opacity: 0.4, height: 0 } as const;

/** Legacy scenes retain their original opaque floor until the user edits ground settings. */
export function directorGroundSettings(scene: Pick<DirectorScene, "ground">): { visible: boolean; opacity: number; height: number } {
    const ground = scene.ground;
    const opacity = ground?.opacity;
    const height = ground?.height;
    return {
        visible: ground?.visible !== false,
        opacity: Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity!)) : 1,
        height: Number.isFinite(height) ? Math.min(2, Math.max(-2, height!)) : 0,
    };
}
