import { describe, expect, test } from "bun:test";

import {
    DIRECTOR_KEYFRAME_EPSILON,
    createDirectorActor,
    createDirectorCamera,
    createDirectorScene,
    interpolateDirectorTransform,
    removeDirectorBoneKeyframe,
    removeDirectorKeyframe,
    removeDirectorSceneKeyframe,
    resolveDirectorKeyframeProgress,
    setDirectorSceneKeyframeEasing,
    upsertDirectorBoneKeyframe,
    upsertDirectorKeyframe,
} from "../src/lib/canvas/director/director-scene";
import type { DirectorKeyframe, DirectorQuat, DirectorScene, DirectorTransform } from "../src/types/director";

const transformAt = (x: number): DirectorTransform => ({ position: [x, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });

function seededKeyframes(): DirectorKeyframe[] {
    let keys: DirectorKeyframe[] = [];
    keys = upsertDirectorKeyframe(keys, 0, transformAt(0));
    keys = upsertDirectorKeyframe(keys, 1, transformAt(10));
    keys = upsertDirectorKeyframe(keys, 2, transformAt(20));
    return keys;
}

describe("删除 transform 关键帧", () => {
    test("按 id 删除只移除目标帧，其余保持有序", () => {
        const keys = seededKeyframes();
        const next = removeDirectorKeyframe(keys, keys[1].id);

        expect(next).toHaveLength(2);
        expect(next.map((k) => k.time)).toEqual([0, 2]);
        // 纯函数：不得改写入参。
        expect(keys).toHaveLength(3);
    });

    test("id 不存在时返回原引用，避免无意义重渲染", () => {
        const keys = seededKeyframes();
        expect(removeDirectorKeyframe(keys, "missing")).toBe(keys);
    });

    test("删空后得到空数组，插值回落到 base", () => {
        let keys = upsertDirectorKeyframe([], 1, transformAt(5));
        keys = removeDirectorKeyframe(keys, keys[0].id);
        expect(keys).toEqual([]);
        expect(interpolateDirectorTransform(transformAt(99), keys, 1).position[0]).toBe(99);
    });

    test("upsert 使用同一容差，记录下的帧一定能按 id 删除", () => {
        // 非整帧时间点最容易出现「记录能覆盖但删不掉」，这里锁住判据一致。
        let keys = upsertDirectorKeyframe([], 0.75, transformAt(3));
        keys = upsertDirectorKeyframe(keys, 0.75 + DIRECTOR_KEYFRAME_EPSILON / 2, transformAt(4));
        expect(keys).toHaveLength(1);
        expect(removeDirectorKeyframe(keys, keys[0].id)).toEqual([]);
    });
});

describe("关键帧缓动", () => {
    test("linear / step / smooth 产生不同且确定的区间进度", () => {
        expect(resolveDirectorKeyframeProgress(0.25, "linear")).toBe(0.25);
        expect(resolveDirectorKeyframeProgress(0.25, "step")).toBe(0);
        expect(resolveDirectorKeyframeProgress(0.25, "smooth")).toBeCloseTo(0.15625, 8);
        expect(resolveDirectorKeyframeProgress(-1, "linear")).toBe(0);
        expect(resolveDirectorKeyframeProgress(2, "linear")).toBe(1);
    });

    test("插值读取前一枚关键帧的 easing，旧数据默认线性", () => {
        const base = seededKeyframes().slice(0, 2);
        expect(interpolateDirectorTransform(transformAt(0), base, 0.25).position[0]).toBeCloseTo(2.5, 8);
        expect(interpolateDirectorTransform(transformAt(0), [{ ...base[0], easing: "step" }, base[1]], 0.25).position[0]).toBe(0);
        expect(interpolateDirectorTransform(transformAt(0), [{ ...base[0], easing: "smooth" }, base[1]], 0.25).position[0]).toBeCloseTo(1.5625, 8);
        expect(interpolateDirectorTransform(transformAt(0), [{ ...base[0], easing: "step" }, base[1]], 1).position[0]).toBe(10);
    });
});

describe("对象属性组关键帧", () => {
    test("只记录位置时，播放插值不改变未记录的旋转和缩放", () => {
        const base: DirectorTransform = { position: [1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
        const keys: DirectorKeyframe[] = [
            { id: "start", time: 0, transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [2, 2, 2] }, positionKeyed: true, rotationKeyed: false, scaleKeyed: false },
            { id: "end", time: 2, transform: { position: [10, 0, 0], rotation: [0, 1, 0], scale: [3, 3, 3] }, positionKeyed: true, rotationKeyed: false, scaleKeyed: false },
        ];
        const rendered = interpolateDirectorTransform(base, keys, 1);
        expect(rendered.position).toEqual([5, 0, 0]);
        expect(rendered.rotation).toEqual([0, 0, 0]);
        expect(rendered.scale).toEqual([1, 1, 1]);
    });

    test("取消位置帧仅移除位置属性，保留同一时刻的旋转帧", () => {
        const scene = createDirectorScene("属性组轨道");
        const actor = createDirectorActor("角色A");
        const key: DirectorKeyframe = { id: "at-1", time: 1, transform: transformAt(4), positionKeyed: true, rotationKeyed: true, scaleKeyed: false };
        const seeded: DirectorScene = { ...scene, objects: [{ ...actor, keyframes: [key] }] };
        const next = removeDirectorSceneKeyframe(seeded, { track: "object-transform", objectId: actor.id, keyframeId: key.id, channel: "position" });
        expect(next.objects[0].keyframes).toHaveLength(1);
        expect(next.objects[0].keyframes[0]).toMatchObject({ positionKeyed: false, rotationKeyed: true, scaleKeyed: false });
        expect(seeded.objects[0].keyframes[0]).toEqual(key);
    });
});

describe("删除骨骼关键帧", () => {
    const rotation: DirectorQuat = [0, 0, 0, 1];

    test("删除后轨道保留其余帧", () => {
        let tracks = upsertDirectorBoneKeyframe([], "hips", 0, rotation);
        tracks = upsertDirectorBoneKeyframe(tracks, "hips", 1, rotation);
        const target = tracks[0].keyframes[0].id;

        const next = removeDirectorBoneKeyframe(tracks, "hips", target);
        expect(next).toHaveLength(1);
        expect(next[0].keyframes).toHaveLength(1);
        expect(next[0].keyframes[0].time).toBe(1);
    });

    test("轨道被删空后整条移除，不留空子轨道", () => {
        const tracks = upsertDirectorBoneKeyframe([], "head", 0, rotation);
        const next = removeDirectorBoneKeyframe(tracks, "head", tracks[0].keyframes[0].id);
        expect(next).toEqual([]);
    });

    test("骨骼或 id 不存在时返回原引用", () => {
        const tracks = upsertDirectorBoneKeyframe([], "head", 0, rotation);
        expect(removeDirectorBoneKeyframe(tracks, "hips", tracks[0].keyframes[0].id)).toBe(tracks);
        expect(removeDirectorBoneKeyframe(tracks, "head", "missing")).toBe(tracks);
    });

    test("只影响目标骨骼，其他轨道不动", () => {
        let tracks = upsertDirectorBoneKeyframe([], "hips", 0, rotation);
        tracks = upsertDirectorBoneKeyframe(tracks, "head", 0, rotation);
        const next = removeDirectorBoneKeyframe(tracks, "hips", tracks[0].keyframes[0].id);
        expect(next.map((t) => t.bone)).toEqual(["head"]);
    });
});

describe("removeDirectorSceneKeyframe：时间轴删除的唯一分派入口", () => {
    const rotation: DirectorQuat = [0, 0, 0, 1];

    /** 一个带对象 transform 帧、骨骼帧和摄影机帧的完整场景。 */
    function seededScene() {
        const base = createDirectorScene("删除测试");
        const actor = {
            ...createDirectorActor("演员 A"),
            keyframes: upsertDirectorKeyframe(upsertDirectorKeyframe([], 0, transformAt(0)), 1, transformAt(10)),
            boneTracks: upsertDirectorBoneKeyframe(upsertDirectorBoneKeyframe([], "hips", 0, rotation), "head", 0.5, rotation),
        };
        const camera = { ...createDirectorCamera("摄影机 A"), keyframes: upsertDirectorKeyframe([], 2, transformAt(5)) };
        const scene: DirectorScene = { ...base, objects: [actor], cameras: [camera] };
        return { scene, actor, camera };
    }

    test("删除对象 transform 帧，只动目标对象", () => {
        const { scene, actor } = seededScene();
        const next = removeDirectorSceneKeyframe(scene, { track: "object-transform", objectId: actor.id, keyframeId: actor.keyframes[0].id });

        expect(next).not.toBe(scene);
        expect(next.objects[0].keyframes.map((key) => key.time)).toEqual([1]);
        // 骨骼轨道和摄影机不受影响，保持原引用。
        expect(next.objects[0].boneTracks).toBe(actor.boneTracks);
        expect(next.cameras).toBe(scene.cameras);
    });

    test("删除骨骼帧，删空的子轨道整条移除", () => {
        const { scene, actor } = seededScene();
        const hips = actor.boneTracks.find((track) => track.bone === "hips");
        const next = removeDirectorSceneKeyframe(scene, { track: "object-bone", objectId: actor.id, bone: "hips", keyframeId: hips!.keyframes[0].id });

        expect(next.objects[0].boneTracks?.map((track) => track.bone)).toEqual(["head"]);
        expect(next.objects[0].keyframes).toBe(actor.keyframes);
    });

    test("删除摄影机帧，只动目标摄影机", () => {
        const { scene, camera } = seededScene();
        const next = removeDirectorSceneKeyframe(scene, { track: "camera", cameraId: camera.id, keyframeId: camera.keyframes[0].id });

        expect(next.cameras[0].keyframes).toEqual([]);
        expect(next.objects).toBe(scene.objects);
    });

    test("删除焦点或视角子轨不会删除同一时刻的位置及另一条光学轨", () => {
        const { scene, camera } = seededScene();
        const key = { ...camera.keyframes[0], rotationKeyed: false, target: [1, 1.2, 0] as [number, number, number], fov: 35 };
        const withOptics: DirectorScene = { ...scene, cameras: [{ ...camera, keyframes: [key] }] };
        const noFocus = removeDirectorSceneKeyframe(withOptics, { track: "camera", cameraId: camera.id, keyframeId: key.id, channel: "focus" });
        expect(noFocus.cameras[0].keyframes).toHaveLength(1);
        expect(noFocus.cameras[0].keyframes[0].target).toBeUndefined();
        expect(noFocus.cameras[0].keyframes[0].fov).toBe(35);
        expect(noFocus.cameras[0].keyframes[0].transform).toEqual(key.transform);

        const noFov = removeDirectorSceneKeyframe(withOptics, { track: "camera", cameraId: camera.id, keyframeId: key.id, channel: "fov" });
        expect(noFov.cameras[0].keyframes[0].target).toEqual([1, 1.2, 0]);
        expect(noFov.cameras[0].keyframes[0].fov).toBeUndefined();
        const noPosition = removeDirectorSceneKeyframe(withOptics, { track: "camera", cameraId: camera.id, keyframeId: key.id, channel: "position" });
        expect(noPosition.cameras[0].keyframes).toHaveLength(1);
        expect(noPosition.cameras[0].keyframes[0].positionKeyed).toBe(false);
        expect(noPosition.cameras[0].keyframes[0].target).toEqual([1, 1.2, 0]);
        expect(noPosition.cameras[0].keyframes[0].fov).toBe(35);
        const withRotation: DirectorScene = { ...scene, cameras: [{ ...camera, keyframes: [{ ...key, rotationKeyed: true }] }] };
        const noRotation = removeDirectorSceneKeyframe(withRotation, { track: "camera", cameraId: camera.id, keyframeId: key.id, channel: "rotation" });
        expect(noRotation.cameras[0].keyframes[0].rotationKeyed).toBe(false);
        expect(noRotation.cameras[0].keyframes[0].positionKeyed).not.toBe(false);
        expect(noRotation.cameras[0].keyframes[0].target).toEqual([1, 1.2, 0]);
        const opticalOnly = removeDirectorSceneKeyframe(noPosition, { track: "camera", cameraId: camera.id, keyframeId: key.id, channel: "focus" });
        const empty = removeDirectorSceneKeyframe(opticalOnly, { track: "camera", cameraId: camera.id, keyframeId: key.id, channel: "fov" });
        expect(empty.cameras[0].keyframes).toEqual([]);
        expect(withOptics.cameras[0].keyframes[0]).toEqual(key);
        expect(removeDirectorSceneKeyframe(noFocus, { track: "camera", cameraId: camera.id, keyframeId: key.id, channel: "focus" })).toBe(noFocus);
    });

    test("未命中一律返回同一 scene 引用：调用方据此跳过历史与保存", () => {
        const { scene, actor, camera } = seededScene();
        // 对象存在但帧 id 不存在。
        expect(removeDirectorSceneKeyframe(scene, { track: "object-transform", objectId: actor.id, keyframeId: "missing" })).toBe(scene);
        // 对象本身不存在。
        expect(removeDirectorSceneKeyframe(scene, { track: "object-transform", objectId: "missing", keyframeId: actor.keyframes[0].id })).toBe(scene);
        // 骨骼轨道不存在。
        expect(removeDirectorSceneKeyframe(scene, { track: "object-bone", objectId: actor.id, bone: "leftHand", keyframeId: "missing" })).toBe(scene);
        // 摄影机不存在。
        expect(removeDirectorSceneKeyframe(scene, { track: "camera", cameraId: "missing", keyframeId: camera.keyframes[0].id })).toBe(scene);
    });

    test("对象没有 boneTracks 时删除骨骼帧不虚构空数组", () => {
        const base = createDirectorScene("无骨骼");
        const object = { ...createDirectorActor("演员 B"), boneTracks: undefined };
        const scene: DirectorScene = { ...base, objects: [object] };
        expect(removeDirectorSceneKeyframe(scene, { track: "object-bone", objectId: object.id, bone: "hips", keyframeId: "any" })).toBe(scene);
    });

    test("不改写入参：原 scene 与原数组保持完整", () => {
        const { scene, actor } = seededScene();
        removeDirectorSceneKeyframe(scene, { track: "object-transform", objectId: actor.id, keyframeId: actor.keyframes[0].id });
        expect(scene.objects[0].keyframes).toHaveLength(2);
    });
});

describe("setDirectorSceneKeyframeEasing：按轨道更新且保持纯函数", () => {
    test("对象、骨骼和摄影机三类目标都能独立更新", () => {
        const base = createDirectorScene("缓动测试");
        const actor = {
            ...createDirectorActor("演员"),
            keyframes: upsertDirectorKeyframe([], 0, transformAt(0)),
            boneTracks: upsertDirectorBoneKeyframe([], "hips", 0, [0, 0, 0, 1]),
        };
        const camera = { ...createDirectorCamera("摄影机"), keyframes: upsertDirectorKeyframe([], 0, transformAt(1)) };
        const scene: DirectorScene = { ...base, objects: [actor], cameras: [camera] };

        const objectNext = setDirectorSceneKeyframeEasing(scene, { track: "object-transform", objectId: actor.id, keyframeId: actor.keyframes[0].id }, "smooth");
        expect(objectNext.objects[0].keyframes[0].easing).toBe("smooth");
        expect(objectNext.cameras).toBe(scene.cameras);

        const boneNext = setDirectorSceneKeyframeEasing(scene, { track: "object-bone", objectId: actor.id, bone: "hips", keyframeId: actor.boneTracks[0].keyframes[0].id }, "step");
        expect(boneNext.objects[0].boneTracks?.[0].keyframes[0].easing).toBe("step");

        const cameraNext = setDirectorSceneKeyframeEasing(scene, { track: "camera", cameraId: camera.id, keyframeId: camera.keyframes[0].id }, "linear");
        expect(cameraNext.cameras[0].keyframes[0].easing).toBe("linear");
        expect(scene.objects[0].keyframes[0].easing).toBeUndefined();
    });

    test("目标不存在时返回原 scene 引用", () => {
        const scene = createDirectorScene("missing");
        expect(setDirectorSceneKeyframeEasing(scene, { track: "camera", cameraId: "missing", keyframeId: "missing" }, "smooth")).toBe(scene);
    });
});
