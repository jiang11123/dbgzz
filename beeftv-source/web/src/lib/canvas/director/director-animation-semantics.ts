import { Euler, Quaternion, Vector3 } from "three";

import type { DirectorBoneKeyframe, DirectorCamera, DirectorCameraMove, DirectorHumanoidBone, DirectorKeyframe, DirectorObject, DirectorQuat, DirectorTransform, DirectorVec3 } from "../../../types/director";
import { DIRECTOR_KEYFRAME_EPSILON, interpolateDirectorBoneRotation, interpolateDirectorTransform, upsertDirectorBoneKeyframe, upsertDirectorKeyframe } from "./director-scene";
import { resolveDirectorCameraTransform } from "./director-view-modes";

// 缩放为 0 时无法用比例表达增量，改用绝对偏移；阈值同时兼顾数值噪声。
const SCALE_EPSILON = 1e-6;

export type DirectorTransformDelta = {
    position: DirectorVec3;
    rotation: DirectorQuat;
    scaleRatio: DirectorVec3;
    scaleOffset: DirectorVec3;
};

export type DirectorNudgeDirection = "up" | "down" | "left" | "right";

/** Move an actor or camera on the ground plane. Actors face the travel direction; cameras move in their local horizontal basis. */
export function resolveDirectorDirectionalNudge(transform: DirectorTransform, direction: DirectorNudgeDirection, distance: number, faceDirection: boolean): DirectorTransform {
    const forward = new Vector3(0, 0, -1).applyEuler(new Euler(0, transform.rotation[1], 0)).normalize();
    const right = new Vector3(1, 0, 0).applyEuler(new Euler(0, transform.rotation[1], 0)).normalize();
    const localVectors: Record<DirectorNudgeDirection, Vector3> = {
        up: forward,
        down: forward.clone().negate(),
        left: right.clone().negate(),
        right,
    };
    const stageVectors: Record<DirectorNudgeDirection, Vector3> = {
        up: new Vector3(0, 0, -1),
        down: new Vector3(0, 0, 1),
        left: new Vector3(-1, 0, 0),
        right: new Vector3(1, 0, 0),
    };
    const vectors = faceDirection ? stageVectors : localVectors;
    const movement = vectors[direction];
    const x = faceDirection ? ({ up: 0, down: 0, left: -1, right: 1 }[direction]) : movement.x;
    const z = faceDirection ? ({ up: -1, down: 1, left: 0, right: 0 }[direction]) : movement.z;
    const rotation = faceDirection ? [0, Math.atan2(x, z), 0] as DirectorVec3 : transform.rotation;
    return {
        ...transform,
        position: [transform.position[0] + movement.x * distance, transform.position[1], transform.position[2] + movement.z * distance],
        rotation,
    };
}

/** Resolve a camera-move preset relative to the camera's aim, not world axes. */
export function resolveDirectorCameraMoveTransform(start: DirectorTransform, target: DirectorVec3, move: DirectorCameraMove): DirectorTransform {
    const position = new Vector3(...start.position);
    const aim = new Vector3(...target);
    const forward = aim.clone().sub(position);
    if (forward.lengthSq() < SCALE_EPSILON) forward.set(0, 0, -1);
    forward.normalize();
    const up = new Vector3(0, 1, 0);
    const right = forward.clone().cross(up).normalize();
    if (right.lengthSq() < SCALE_EPSILON) right.set(1, 0, 0);
    const distance = Math.max(0.1, position.distanceTo(aim));
    const next = position.clone();
    const orientation = new Quaternion().setFromEuler(new Euler(...start.rotation));
    let nextRotation: DirectorVec3 | null = null;

    switch (move) {
        case "push_in": next.addScaledVector(forward, Math.min(2, distance * 0.45)); break;
        case "pull_out": next.addScaledVector(forward, -2); break;
        // Pan/tilt are rotations from a fixed camera position, not a truck/dolly.
        case "pan_left": orientation.premultiply(new Quaternion().setFromAxisAngle(up, Math.PI / 9)); nextRotation = new Euler().setFromQuaternion(orientation).toArray().slice(0, 3) as DirectorVec3; break;
        case "pan_right": orientation.premultiply(new Quaternion().setFromAxisAngle(up, -Math.PI / 9)); nextRotation = new Euler().setFromQuaternion(orientation).toArray().slice(0, 3) as DirectorVec3; break;
        case "tilt_up": orientation.multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 12)); nextRotation = new Euler().setFromQuaternion(orientation).toArray().slice(0, 3) as DirectorVec3; break;
        case "tilt_down": orientation.multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 15)); nextRotation = new Euler().setFromQuaternion(orientation).toArray().slice(0, 3) as DirectorVec3; break;
        case "orbit_left": next.sub(aim).applyAxisAngle(up, Math.PI / 6).add(aim); break;
        case "orbit_right": next.sub(aim).applyAxisAngle(up, -Math.PI / 6).add(aim); break;
        case "handheld": next.addScaledVector(right, 0.18).add(new Vector3(0, 0.08, 0)).addScaledVector(forward, 0.15); break;
        case "static": break;
    }

    return { ...start, position: next.toArray() as DirectorVec3, rotation: nextRotation || start.rotation };
}

/** Pan/tilt keyframes define aim through orientation; positional moves keep their existing aim mode. */
export function resolveDirectorCameraMoveLookAtMode(current: DirectorCamera["lookAtMode"], move: DirectorCameraMove): DirectorCamera["lookAtMode"] {
    return move === "pan_left" || move === "pan_right" || move === "tilt_up" || move === "tilt_down" ? "rotation" : current;
}

export function directorTransformDelta(from: DirectorTransform, to: DirectorTransform): DirectorTransformDelta {
    const fromQuaternion = new Quaternion().setFromEuler(new Euler(...from.rotation));
    const toQuaternion = new Quaternion().setFromEuler(new Euler(...to.rotation));
    const scaleRatio: DirectorVec3 = [1, 1, 1];
    const scaleOffset: DirectorVec3 = [0, 0, 0];
    from.scale.forEach((value, index) => {
        if (Math.abs(value) > SCALE_EPSILON) {
            scaleRatio[index] = to.scale[index] / value;
            return;
        }
        scaleOffset[index] = to.scale[index] - value;
    });
    return {
        position: [to.position[0] - from.position[0], to.position[1] - from.position[1], to.position[2] - from.position[2]],
        rotation: toQuaternion.multiply(fromQuaternion.invert()).toArray() as DirectorQuat,
        scaleRatio,
        scaleOffset,
    };
}

export function applyDirectorTransformDelta(transform: DirectorTransform, delta: DirectorTransformDelta): DirectorTransform {
    const rotated = new Quaternion(...delta.rotation).multiply(new Quaternion().setFromEuler(new Euler(...transform.rotation)));
    return {
        position: transform.position.map((value, index) => value + delta.position[index]) as DirectorVec3,
        rotation: new Euler().setFromQuaternion(rotated).toArray().slice(0, 3) as DirectorVec3,
        scale: transform.scale.map((value, index) => value * delta.scaleRatio[index] + delta.scaleOffset[index]) as DirectorVec3,
    };
}

export function snapDirectorTime(time: number, fps: number) {
    const safeFps = fps > 0 ? fps : 24;
    return Math.max(0, Math.round(time * safeFps) / safeFps);
}

export type DirectorObjectTransformEdit = {
    transform: DirectorTransform;
    keyframes: DirectorKeyframe[];
};

/**
 * 静态与动画语义的唯一入口。
 * autoKey 打开：只写当前吸附播放头上的关键帧，base 与其他关键帧保持不变。
 * autoKey 关闭：把「渲染值 -> 编辑值」的增量整体搬到 base 和所有已有关键帧，
 * 使编辑在存在关键帧时依然可见，且不改变未被编辑场景的既有渲染结果。
 */
export function resolveDirectorObjectTransformEdit(input: { base: DirectorTransform; keyframes: DirectorKeyframe[]; rendered: DirectorTransform; edited: DirectorTransform; autoKey: boolean; time: number }): DirectorObjectTransformEdit {
    const { base, keyframes, rendered, edited, autoKey, time } = input;
    if (autoKey) {
        const current = keyframes.find((key) => Math.abs(key.time - time) < DIRECTOR_KEYFRAME_EPSILON);
        const written = upsertDirectorKeyframe(keyframes, time, edited);
        if (!current) return { transform: base, keyframes: written };
        const changed = (channel: "position" | "rotation" | "scale") => edited[channel].some((value, axis) => Math.abs(value - rendered[channel][axis]) > 1e-6);
        return { transform: base, keyframes: written.map((key) => key.id === current.id ? {
            ...key,
            positionKeyed: changed("position") ? true : key.positionKeyed,
            rotationKeyed: changed("rotation") ? true : key.rotationKeyed,
            scaleKeyed: changed("scale") ? true : key.scaleKeyed,
        } : key) };
    }
    if (!keyframes.length) return { transform: edited, keyframes };
    const delta = directorTransformDelta(rendered, edited);
    return {
        transform: applyDirectorTransformDelta(base, delta),
        keyframes: keyframes.map((keyframe) => ({ ...keyframe, transform: applyDirectorTransformDelta(keyframe.transform, delta) })),
    };
}

/** Apply the representative object's transform delta to a multi-selection while preserving layout. */
export function resolveDirectorMultiObjectTransformEdit(input: { objects: DirectorObject[]; selectedIds: string[]; representativeId: string; from: DirectorTransform; to: DirectorTransform; autoKey: boolean; time: number }): DirectorObject[] {
    const selected = new Set(input.selectedIds);
    if (!selected.has(input.representativeId)) return input.objects;
    const delta = directorTransformDelta(input.from, input.to);
    return input.objects.map((object) => {
        if (!selected.has(object.id)) return object;
        const rendered = interpolateDirectorTransform(object.transform, object.keyframes, input.time);
        const edited = applyDirectorTransformDelta(rendered, delta);
        const result = resolveDirectorObjectTransformEdit({ base: object.transform, keyframes: object.keyframes, rendered, edited, autoKey: input.autoKey, time: input.time });
        // Inspector edits resize/rotate the model, while only translation moves its path.
        const motionPath = object.motionPath && !input.autoKey ? { ...object.motionPath, transform: { ...object.motionPath.transform, position: object.motionPath.transform.position.map((value, axis) => value + delta.position[axis]) as DirectorVec3 } } : object.motionPath;
        return { ...object, transform: result.transform, keyframes: result.keyframes, motionPath };
    });
}

/** Apply a viewport group-gizmo transform around the selection pivot. */
export function resolveDirectorMultiObjectGroupTransformEdit(input: { objects: DirectorObject[]; selectedIds: string[]; from: DirectorTransform; to: DirectorTransform; autoKey: boolean; time: number }): DirectorObject[] {
    const selected = new Set(input.selectedIds);
    const fromRotation = new Quaternion().setFromEuler(new Euler(...input.from.rotation));
    const toRotation = new Quaternion().setFromEuler(new Euler(...input.to.rotation));
    const inverseFromRotation = fromRotation.clone().invert();
    const deltaRotation = toRotation.clone().multiply(inverseFromRotation);
    const ratios = input.from.scale.map((value, index) => Math.abs(value) > SCALE_EPSILON ? input.to.scale[index] / value : 1) as DirectorVec3;
    const scaleDelta = new Vector3(...ratios);
    return input.objects.map((object) => {
        if (!selected.has(object.id)) return object;
        const rendered = interpolateDirectorTransform(object.transform, object.keyframes, input.time);
        const transformPosition = (position: DirectorVec3) => new Vector3(...position)
            .sub(new Vector3(...input.from.position))
            .applyQuaternion(inverseFromRotation)
            .multiply(scaleDelta)
            .applyQuaternion(toRotation)
            .add(new Vector3(...input.to.position)).toArray() as DirectorVec3;
        const renderedRotation = new Quaternion().setFromEuler(new Euler(...rendered.rotation));
        const editedRotation = deltaRotation.clone().multiply(renderedRotation);
        const edited: DirectorTransform = {
            position: transformPosition(rendered.position),
            rotation: new Euler().setFromQuaternion(editedRotation).toArray().slice(0, 3) as DirectorVec3,
            scale: rendered.scale.map((value, index) => value * ratios[index]) as DirectorVec3,
        };
        const result = resolveDirectorObjectTransformEdit({ base: object.transform, keyframes: object.keyframes, rendered, edited, autoKey: input.autoKey, time: input.time });
        if (!object.motionPath || input.autoKey) return { ...object, transform: result.transform, keyframes: result.keyframes };
        // A path is one spatial object: apply the group matrix to every sample and its pivot.
        const delta = directorTransformDelta(rendered, edited);
        const transformWholePath = (transform: DirectorTransform): DirectorTransform => ({ ...applyDirectorTransformDelta(transform, delta), position: transformPosition(transform.position) });
        return { ...object, transform: transformWholePath(object.transform), keyframes: object.keyframes.map((key) => ({ ...key, transform: transformWholePath(key.transform) })), motionPath: { ...object.motionPath, transform: transformWholePath(object.motionPath.transform) } };
    });
}

export type DirectorBoneLayerInput = {
    /** 有动作片段时由 mixer 求值的当前旋转；无动作时为空。 */
    motion?: DirectorQuat | null;
    /** 静默姿势下的骨骼静置旋转。 */
    rest?: DirectorQuat | null;
    /** 姿势预设相对静置的增量。 */
    poseDelta?: DirectorQuat | null;
    /** 静态骨骼覆盖值。 */
    override?: DirectorQuat | null;
    /** 骨骼关键帧轨道。 */
    keyframes?: DirectorBoneKeyframe[] | null;
    time: number;
};

/**
 * 骨骼求值优先级（低到高）：静置/姿势或动作片段 -> 静态覆盖 -> 骨骼关键帧。
 * 手指骨骼与主干骨骼共用同一规则。
 */
export function resolveDirectorBoneRotation(input: DirectorBoneLayerInput): DirectorQuat | null {
    const motionOrRest = input.motion ? input.motion : input.rest ? (input.poseDelta ? (new Quaternion(...input.rest).multiply(new Quaternion(...input.poseDelta)).toArray() as DirectorQuat) : input.rest) : null;
    const staged = input.override || motionOrRest;
    const keyframes = input.keyframes || [];
    if (!keyframes.length) return input.override || null;
    if (!staged) return interpolateDirectorBoneRotation([0, 0, 0, 1], keyframes, input.time);
    return interpolateDirectorBoneRotation(staged, keyframes, input.time);
}

/** Apply the representative bone-rotation delta across selected actors without flattening their relative poses. */
export function resolveDirectorMultiObjectBoneRotationEdit(input: { objects: DirectorObject[]; selectedIds: string[]; representativeId: string; bone: DirectorHumanoidBone; from: DirectorQuat; to: DirectorQuat; autoKey: boolean; time: number }): DirectorObject[] {
    const selected = new Set(input.selectedIds);
    if (!selected.has(input.representativeId)) return input.objects;
    const delta = new Quaternion(...input.to).multiply(new Quaternion(...input.from).invert());
    const identity: DirectorQuat = [0, 0, 0, 1];
    return input.objects.map((object) => {
        if (!selected.has(object.id)) return object;
        const boneTrack = object.boneTracks?.find((track) => track.bone === input.bone);
        const current = resolveDirectorBoneRotation({ override: object.boneOverrides?.[input.bone], keyframes: boneTrack?.keyframes, time: input.time }) || identity;
        const edited = delta.clone().multiply(new Quaternion(...current)).toArray() as DirectorQuat;
        if (input.autoKey) {
            return {
                ...object,
                boneOverrides: { ...object.boneOverrides, [input.bone]: edited },
                boneTracks: upsertDirectorBoneKeyframe(object.boneTracks || [], input.bone, input.time, edited),
            };
        }
        const baseOverride = object.boneOverrides?.[input.bone] || identity;
        return {
            ...object,
            boneOverrides: { ...object.boneOverrides, [input.bone]: delta.clone().multiply(new Quaternion(...baseOverride)).toArray() as DirectorQuat },
            boneTracks: (object.boneTracks || []).map((track) => track.bone === input.bone ? {
                ...track,
                keyframes: track.keyframes.map((keyframe) => ({ ...keyframe, rotation: delta.clone().multiply(new Quaternion(...keyframe.rotation)).toArray() as DirectorQuat })),
            } : track),
        };
    });
}

export type DirectorGestureState = { active: boolean; committed: boolean; transforming: boolean };
export type DirectorGestureEvent = "start" | "commit" | "cancel";

export const directorGestureIdle: DirectorGestureState = { active: false, committed: false, transforming: false };

/**
 * 一次手势只允许一个终态：commit 恰好提交一次，任何终态都必须清掉 transforming，
 * 否则 OrbitControls 会一直停留在禁用状态。
 */
export function reduceDirectorGesture(state: DirectorGestureState, event: DirectorGestureEvent): DirectorGestureState {
    if (event === "start") return { active: true, committed: false, transforming: true };
    if (!state.active) return { ...directorGestureIdle, committed: false };
    if (event === "commit") return { active: false, committed: true, transforming: false };
    return { active: false, committed: false, transforming: false };
}

/**
 * 记录关键帧：取值时间与写入时间是两个不同的量。
 * 取值用 raw playhead（视口真正渲染的时间），写入用 snapped 目的时间。
 */
export function resolveDirectorKeyframeRecord(input: { base: DirectorTransform; keyframes: DirectorKeyframe[]; rawTime: number; snappedTime: number; channel?: "position" | "rotation" | "scale" }) {
    const rendered = interpolateDirectorTransform(input.base, input.keyframes, input.rawTime);
    const current = input.keyframes.find((key) => Math.abs(key.time - input.snappedTime) < DIRECTOR_KEYFRAME_EPSILON);
    if (!input.channel) {
        const keyframes = upsertDirectorKeyframe(input.keyframes, input.snappedTime, rendered).map((key) => Math.abs(key.time - input.snappedTime) < DIRECTOR_KEYFRAME_EPSILON
            ? { ...key, positionKeyed: true, rotationKeyed: true, scaleKeyed: true } : key);
        return { time: input.snappedTime, transform: rendered, keyframes };
    }
    const channel = input.channel;
    const keyed = `${channel}Keyed` as const;
    if (current?.[keyed] !== false && current) {
        const next = { ...current, [keyed]: false };
        const keyframes = next.positionKeyed === false && next.rotationKeyed === false && next.scaleKeyed === false
            ? input.keyframes.filter((key) => key.id !== current.id)
            : input.keyframes.map((key) => key.id === current.id ? next : key);
        return { time: input.snappedTime, transform: rendered, keyframes };
    }
    const keyframes = current
        ? input.keyframes.map((key) => key.id === current.id ? { ...key, transform: { ...key.transform, [channel]: rendered[channel] }, [keyed]: true } : key)
        : upsertDirectorKeyframe(input.keyframes, input.snappedTime, rendered).map((key) => Math.abs(key.time - input.snappedTime) < DIRECTOR_KEYFRAME_EPSILON
            ? { ...key, positionKeyed: channel === "position", rotationKeyed: channel === "rotation", scaleKeyed: channel === "scale" } : key);
    return { time: input.snappedTime, transform: rendered, keyframes };
}

/**
 * 把自由观察相机显式写回实际摄影机。
 *
 * 没有动画轨道时更新基础 transform；已有轨道时写当前播放头关键帧，否则旧关键帧会
 * 继续接管 CAM 取景，让界面提示“已对齐”但画面立即跳回旧位置。
 */
export function resolveDirectorCameraAlignment(camera: DirectorCamera, transform: DirectorTransform, time: number): DirectorCamera {
    if (!camera.keyframes.length) return { ...camera, transform };
    return { ...camera, keyframes: upsertDirectorKeyframe(camera.keyframes, time, transform).map((key) => Math.abs(key.time - time) < DIRECTOR_KEYFRAME_EPSILON ? { ...key, positionKeyed: true } : key) };
}

/** Apply a viewport gizmo edit relative to the rendered camera pose at the playhead. */
export function resolveDirectorCameraGizmoEdit(input: { camera: DirectorCamera; from: DirectorTransform; edited: DirectorTransform; rawTime: number; snappedTime: number }): DirectorCamera {
    const { camera, from, edited } = input;
    const rendered = resolveDirectorCameraTransform(camera, input.rawTime);
    const position = rendered.position.map((value, axis) => value + edited.position[axis] - from.position[axis]) as DirectorVec3;
    const transform: DirectorTransform = { ...rendered, position, rotation: edited.rotation, scale: edited.scale };
    const rotationChanged = new Quaternion().setFromEuler(new Euler(...from.rotation)).angleTo(new Quaternion().setFromEuler(new Euler(...edited.rotation))) > 1e-4;
    const aligned = resolveDirectorCameraAlignment(camera, transform, input.snappedTime);
    return rotationChanged ? { ...aligned, lookAtMode: "rotation", lookAtObjectId: undefined, keyframes: aligned.keyframes.map((key) => Math.abs(key.time - input.snappedTime) < DIRECTOR_KEYFRAME_EPSILON ? { ...key, rotationKeyed: true } : key) } : aligned;
}

/** 生成运镜只更新首尾帧；保留用户手工添加的中间帧、帧 id 与 easing。 */
export function resolveDirectorCameraMoveKeyframes(keyframes: DirectorKeyframe[], start: DirectorTransform, end: DirectorTransform, duration: number) {
    const endTime = Number.isFinite(duration) && duration > 0 ? duration : 0;
    return upsertDirectorKeyframe(upsertDirectorKeyframe(keyframes, 0, start), endTime, end);
}

/** 播放头按镜头时长循环；非法输入回落 0，长帧也保留越界余量。 */
export function advanceDirectorPlayhead(playhead: number, elapsed: number, duration: number) {
    if (!Number.isFinite(duration) || duration <= 0) return 0;
    const current = Number.isFinite(playhead) ? playhead : 0;
    const delta = Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0;
    return (((current + delta) % duration) + duration) % duration;
}

/**
 * 暂停且相机没有被关键帧驱动时不写相机，避免与用户 Orbit 操作互相抢夺。
 * key 必须包含该 playhead 上真正解算出的 transform，否则「同一 playhead 改关键帧内容」
 * 不会引起重新同步。
 */
export function directorCameraSyncKey(input: { camera?: { id: string; transform: DirectorTransform; target: DirectorVec3; fov: number; near: number; far: number; keyframes: DirectorKeyframe[] } | null; playhead: number; playing: boolean }) {
    const { camera, playhead, playing } = input;
    if (!camera) return null;
    const animated = playing || camera.keyframes.length > 0;
    const resolved = interpolateDirectorTransform(camera.transform, camera.keyframes, playhead);
    const statics = [camera.id, ...resolved.position, ...resolved.rotation, ...resolved.scale, ...camera.target, camera.fov, camera.near, camera.far].join(":");
    return animated ? `${statics}@${playhead.toFixed(4)}` : statics;
}
