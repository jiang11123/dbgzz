import { Euler, Matrix4, Quaternion, Vector3 } from "three";

import type { DirectorScene, DirectorTransform, DirectorVec3 } from "@/types/director";

export type DirectorStageTransform = NonNullable<DirectorScene["stageTransform"]>;

export const DIRECTOR_DEFAULT_STAGE_TRANSFORM: DirectorStageTransform = {
    scale: 1,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
};

export function directorStageTransform(scene: Pick<DirectorScene, "stageTransform">): DirectorStageTransform {
    const value = scene.stageTransform;
    if (!value || !Number.isFinite(value.scale) || value.scale < 0.1 || value.scale > 10) return DIRECTOR_DEFAULT_STAGE_TRANSFORM;
    if (![value.position, value.rotation].every((axis) => Array.isArray(axis) && axis.length === 3 && axis.every(Number.isFinite))) return DIRECTOR_DEFAULT_STAGE_TRANSFORM;
    return value;
}

export function directorStageMatrix(stage: DirectorStageTransform): Matrix4 {
    const rotation = new Euler(...stage.rotation.map((degrees) => degrees * Math.PI / 180) as DirectorVec3);
    return new Matrix4().compose(new Vector3(...stage.position), new Quaternion().setFromEuler(rotation), new Vector3(stage.scale, stage.scale, stage.scale));
}

export function directorStagePoint(stage: DirectorStageTransform, point: DirectorVec3): DirectorVec3 {
    return new Vector3(...point).applyMatrix4(directorStageMatrix(stage)).toArray() as DirectorVec3;
}

export function directorStageLocalPoint(stage: DirectorStageTransform, point: DirectorVec3): DirectorVec3 {
    return new Vector3(...point).applyMatrix4(directorStageMatrix(stage).invert()).toArray() as DirectorVec3;
}

export function directorStageDirection(stage: DirectorStageTransform, direction: DirectorVec3): DirectorVec3 {
    const result = new Vector3(...direction).transformDirection(directorStageMatrix(stage));
    return result.toArray() as DirectorVec3;
}

/** Convert a world-space viewport camera back into local scene coordinates before saving it. */
export function directorStageLocalCamera(stage: DirectorStageTransform, world: DirectorTransform): DirectorTransform {
    if (stage.scale === 1 && stage.position.every((value) => value === 0) && stage.rotation.every((value) => value === 0)) return world;
    const worldRotation = new Quaternion().setFromEuler(new Euler(...world.rotation));
    const stageRotation = new Quaternion().setFromEuler(new Euler(...stage.rotation.map((degrees) => degrees * Math.PI / 180) as DirectorVec3));
    const localRotation = new Euler().setFromQuaternion(stageRotation.invert().multiply(worldRotation));
    return {
        ...world,
        position: directorStageLocalPoint(stage, world.position),
        rotation: [localRotation.x, localRotation.y, localRotation.z],
    };
}
