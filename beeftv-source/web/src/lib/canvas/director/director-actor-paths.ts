import { nanoid } from "nanoid";
import { CatmullRomCurve3, Euler, Quaternion, Vector3 } from "three";

import type { DirectorKeyframe, DirectorObject, DirectorTransform, DirectorVec3 } from "@/types/director";
import { upsertDirectorKeyframe } from "@/lib/canvas/director/director-scene";
import { resampleDirectorGroundPath } from "@/lib/canvas/director/director-path-sampling";

export type DirectorActorPathKind = "line" | "ring" | "rectangle";

export function createDirectorActorPenPath(object: DirectorObject, points: { x: number; z: number }[], duration: number): DirectorObject | null {
    const controls: { x: number; z: number }[] = [];
    for (const point of points) {
        if (!Number.isFinite(point.x) || !Number.isFinite(point.z)) continue;
        const prior = controls.at(-1);
        if (!prior || Math.hypot(point.x - prior.x, point.z - prior.z) >= 0.05) controls.push(point);
    }
    if (controls.length < 2) return null;
    const [x, y, z] = object.transform.position;
    const anchors = [[x, y, z], ...controls.map((point) => [point.x, y, point.z])] as DirectorVec3[];
    const curve = new CatmullRomCurve3(anchors.map((point) => new Vector3(...point)), false, "centripetal");
    const segments = (anchors.length - 1) * 8;
    const seconds = Number.isFinite(duration) && duration > 0 ? duration : 10;
    const keyframes: DirectorKeyframe[] = Array.from({ length: segments + 1 }, (_, index) => ({
        id: nanoid(),
        time: seconds * index / segments,
        transform: { ...object.transform, position: curve.getPoint(index / segments).toArray() as DirectorVec3 },
        easing: "linear",
    }));
    const controlKeyframeIds = anchors.map((_, index) => keyframes[index * 8].id);
    const withPath: DirectorObject = {
        ...object,
        keyframes,
        motionPath: {
            kind: "pen", duration: seconds, facePath: true,
            transform: { position: [(Math.min(...anchors.map((point) => point[0])) + Math.max(...anchors.map((point) => point[0]))) / 2, y, (Math.min(...anchors.map((point) => point[2])) + Math.max(...anchors.map((point) => point[2]))) / 2], rotation: [0, 0, 0], scale: [1, 1, 1] },
            originalKeyframes: object.motionPath?.originalKeyframes || object.keyframes,
            controlKeyframeIds,
        },
    };
    return setDirectorActorPathFacing(withPath, true);
}

export function createDirectorActorPencilPath(object: DirectorObject, points: { x: number; z: number }[], duration: number): DirectorObject | null {
    const sampled: { x: number; z: number }[] = [];
    for (const point of points) {
        if (!Number.isFinite(point.x) || !Number.isFinite(point.z)) continue;
        const last = sampled.at(-1);
        if (!last || Math.hypot(point.x - last.x, point.z - last.z) > 1e-6) sampled.push(point);
    }
    const finalPoint = points.at(-1);
    const lastSample = sampled.at(-1);
    if (finalPoint && lastSample && Number.isFinite(finalPoint.x) && Number.isFinite(finalPoint.z) && Math.hypot(finalPoint.x - lastSample.x, finalPoint.z - lastSample.z) > 1e-6) sampled.push(finalPoint);
    const resampled = resampleDirectorGroundPath(sampled, 10);
    if (resampled.length < 2) return null;
    const distances = resampled.map((point, index) => index ? Math.hypot(point.x - resampled[index - 1].x, point.z - resampled[index - 1].z) : 0);
    const length = distances.reduce((sum, segment) => sum + segment, 0);
    if (length < 1e-5) return null;
    const seconds = Number.isFinite(duration) && duration > 0 ? duration : 10;
    const origin = resampled[0];
    const positions = resampled.map((point) => [object.transform.position[0] + point.x - origin.x, object.transform.position[1], object.transform.position[2] + point.z - origin.z] as DirectorVec3);
    const minX = Math.min(...positions.map((point) => point[0]));
    const maxX = Math.max(...positions.map((point) => point[0]));
    const minZ = Math.min(...positions.map((point) => point[2]));
    const maxZ = Math.max(...positions.map((point) => point[2]));
    const keyframes: DirectorKeyframe[] = positions.map((position, index) => {
        return { id: nanoid(), time: seconds * index / (positions.length - 1), transform: { ...object.transform, position }, easing: "linear" };
    });
    const withPath: DirectorObject = {
        ...object,
        keyframes,
        motionPath: { kind: "pencil", duration: seconds, facePath: true, transform: { position: [(minX + maxX) / 2, object.transform.position[1], (minZ + maxZ) / 2], rotation: [0, 0, 0], scale: [1, 1, 1] }, originalKeyframes: object.motionPath?.originalKeyframes || object.keyframes },
    };
    return setDirectorActorPathFacing(withPath, true);
}

export function createDirectorActorPath(object: DirectorObject, kind: DirectorActorPathKind, duration: number): DirectorObject {
    const seconds = Number.isFinite(duration) && duration > 0 ? duration : 10;
    const [x, y, z] = object.transform.position;
    const positions: DirectorVec3[] = kind === "line"
        ? [[x, y, z], [x, y, z + 4]]
        : kind === "ring"
            ? Array.from({ length: 33 }, (_, index) => {
                const angle = index * Math.PI / 16;
                return [x - 2 + 2 * Math.cos(angle), y, z + 2 * Math.sin(angle)];
            })
            : [[x, y, z], [x + 4, y, z], [x + 4, y, z + 3], [x, y, z + 3], [x, y, z]];
    const center: DirectorVec3 = kind === "line" ? [x, y, z + 2] : kind === "ring" ? [x - 2, y, z] : [x + 2, y, z + 1.5];
    const keyframes: DirectorKeyframe[] = positions.map((position, index) => ({
        id: nanoid(),
        time: index === positions.length - 1 ? seconds : seconds * index / (positions.length - 1),
        transform: { ...object.transform, position },
        easing: kind === "ring" ? "smooth" : "linear",
    }));
    const withPath: DirectorObject = {
        ...object,
        keyframes,
        motionPath: { kind, duration: seconds, facePath: true, transform: { position: center, rotation: [0, 0, 0], scale: [1, 1, 1] }, originalKeyframes: object.motionPath?.originalKeyframes || object.keyframes, ...(kind === "ring" ? { controlKeyframeIds: [keyframes[0].id, keyframes[16].id, keyframes[32].id] } : {}) },
    };
    return setDirectorActorPathFacing(withPath, true);
}

export function retimeDirectorActorPath(object: DirectorObject, duration: number): DirectorObject {
    if (!object.motionPath || !Number.isFinite(duration) || duration <= 0) return object;
    const prior = object.motionPath.duration;
    return { ...object, motionPath: { ...object.motionPath, duration }, keyframes: object.keyframes.map((frame) => ({ ...frame, time: frame.time * duration / prior })) };
}

export function editDirectorActorPathAtTime(object: DirectorObject, time: number, transform: DirectorTransform): DirectorObject {
    if (!object.motionPath || !Number.isFinite(time)) return object;
    return { ...object, keyframes: upsertDirectorKeyframe(object.keyframes, Math.max(0, Math.min(object.motionPath.duration, time)), transform) };
}

export function updateDirectorActorPathTransform(object: DirectorObject, transform: DirectorTransform): DirectorObject {
    if (!object.motionPath) return object;
    const previous = object.motionPath.transform;
    const oldCenter = new Vector3(...previous.position);
    const nextCenter = new Vector3(...transform.position);
    const nextRotation = new Quaternion().setFromEuler(new Euler(...transform.rotation));
    const oldRotationInverse = new Quaternion().setFromEuler(new Euler(...previous.rotation)).invert();
    const rotationDelta = nextRotation.multiply(oldRotationInverse);
    const scaleRatio = transform.scale.map((axis, index) => axis / (Math.abs(previous.scale[index]) > 1e-6 ? previous.scale[index] : 1)) as DirectorVec3;
    const keyframes = object.keyframes.map((frame) => {
        const offset = new Vector3(...frame.transform.position).sub(oldCenter);
        offset.multiply(new Vector3(...scaleRatio)).applyQuaternion(rotationDelta);
        return { ...frame, transform: { ...frame.transform, position: nextCenter.clone().add(offset).toArray() as DirectorVec3 } };
    });
    const result: DirectorObject = { ...object, keyframes, motionPath: { ...object.motionPath, transform } };
    return object.motionPath.facePath ? setDirectorActorPathFacing(result, true) : result;
}

export function setDirectorActorPathFacing(object: DirectorObject, facing: boolean): DirectorObject {
    if (!object.motionPath) return object;
    const keyframes = object.keyframes.map((frame, index, all) => {
        const from = all[index === all.length - 1 && object.motionPath?.kind === "ring" ? 0 : index].transform.position;
        const to = all[index === all.length - 1 ? index === 0 ? 0 : index - 1 : index + 1].transform.position;
        const dx = index === all.length - 1 ? from[0] - to[0] : to[0] - from[0];
        const dz = index === all.length - 1 ? from[2] - to[2] : to[2] - from[2];
        const yaw = Math.hypot(dx, dz) > 1e-6 ? Math.atan2(dx, dz) : object.transform.rotation[1];
        return { ...frame, transform: { ...frame.transform, rotation: facing ? [object.transform.rotation[0], yaw, object.transform.rotation[2]] as DirectorVec3 : [...object.transform.rotation] as DirectorVec3 } };
    });
    return { ...object, motionPath: { ...object.motionPath, facePath: facing }, keyframes };
}

export function removeDirectorActorPath(object: DirectorObject): DirectorObject {
    if (!object.motionPath) return object;
    const { motionPath, ...rest } = object;
    return { ...rest, keyframes: motionPath.originalKeyframes };
}
