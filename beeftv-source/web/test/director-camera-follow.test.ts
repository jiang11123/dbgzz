import { describe, expect, test } from "bun:test";

import { createDirectorReproScene } from "../src/lib/canvas/director/director-repro-fixture";
import { resolveDirectorCameraLocalFraming, resolveDirectorViewFraming } from "../src/lib/canvas/director/director-view-modes";
import { resolveDirectorCameraGizmoEdit, resolveDirectorCameraMoveKeyframes, resolveDirectorCameraMoveLookAtMode, resolveDirectorCameraMoveTransform } from "../src/lib/canvas/director/director-animation-semantics";
import { bindDirectorCameraFollow, removeDirectorCameraBindingsForObject, unbindDirectorCameraFollow } from "../src/lib/canvas/director/director-camera-binding";
import type { DirectorCamera, DirectorVec3 } from "../src/types/director";

const movedScene = () => {
    const scene = createDirectorReproScene();
    const object = scene.objects[0];
    return { ...scene, objects: [{ ...object, keyframes: [
        { id: "k0", time: 0, transform: object.transform },
        { id: "k2", time: 2, transform: { ...object.transform, position: [2, 0.5, 0] as DirectorVec3 } },
    ] }, ...scene.objects.slice(1)] };
};

describe("导演台摄影机跟随与注视", () => {
    test("机位移动保留注视模式，机位旋转切换为旋转驱动并真实改变取景", () => {
        const scene = createDirectorReproScene();
        const camera = scene.cameras[0];
        const movedTransform = { ...camera.transform, position: [camera.transform.position[0] + 2, camera.transform.position[1], camera.transform.position[2]] as DirectorVec3 };
        const moved = resolveDirectorCameraGizmoEdit({ camera, from: camera.transform, edited: movedTransform, rawTime: 0, snappedTime: 0 });
        expect(moved.lookAtMode).toBe(camera.lookAtMode);
        expect(moved.transform.position).toEqual(movedTransform.position);
        expect(moved.target).toEqual(camera.target);

        const rotatedTransform = { ...camera.transform, rotation: [0, Math.PI / 2, 0] as DirectorVec3 };
        const rotated = resolveDirectorCameraGizmoEdit({ camera, from: camera.transform, edited: rotatedTransform, rawTime: 0, snappedTime: 0 });
        expect(rotated.lookAtMode).toBe("rotation");
        expect(rotated.target).toEqual(camera.target);
        const framing = resolveDirectorCameraLocalFraming(scene, rotated, 0);
        expect(framing?.target[0]).toBeCloseTo(camera.transform.position[0] - 1, 5);
        expect(framing?.target[1]).toBeCloseTo(camera.transform.position[1], 5);
        expect(framing?.target[2]).toBeCloseTo(camera.transform.position[2], 5);
    });

    test("相机操纵器用 raw 播放头取渲染起点、用吸附播放头写关键帧", () => {
        const scene = createDirectorReproScene();
        const camera = scene.cameras[0];
        const trajectory = {
            ...camera,
            keyframes: [
                { id: "start", time: 0, transform: camera.transform },
                { id: "end", time: 2, transform: { ...camera.transform, position: [10, 2.7, 6.8] as DirectorVec3 } },
            ],
        };
        const rawTime = 1.02;
        const from = { ...camera.transform, position: [7.452, 2.7, 6.8] as DirectorVec3 };
        const edited = { ...from, position: [7.452, 3.7, 6.8] as DirectorVec3 };
        const result = resolveDirectorCameraGizmoEdit({ camera: trajectory, from, edited, rawTime, snappedTime: 1 });
        const inserted = result.keyframes.find((frame) => frame.time === 1);
        expect(inserted?.transform.position).toEqual([7.452, 3.7, 6.8]);
        expect(result.keyframes.map((frame) => frame.time)).toEqual([0, 1, 2]);
    });

    test("绑定跟随后当前画面不跳变，角色移动时相机保留相对位置", () => {
        const scene = movedScene();
        const camera = bindDirectorCameraFollow(scene.cameras[0], scene, scene.objects[0].id, 0);
        const next = { ...scene, cameras: [camera] };
        expect(resolveDirectorViewFraming({ scene: next, mode: "camera", playhead: 0 })?.position).toEqual([4.8, 2.7, 6.8]);
        expect(resolveDirectorViewFraming({ scene: next, mode: "camera", playhead: 1 })?.position).toEqual([5.8, 2.7, 6.8]);
    });

    test("注视角色使用当前帧位置，镜头位置不受注视绑定影响", () => {
        const scene = movedScene();
        const camera = { ...scene.cameras[0], lookAtObjectId: scene.objects[0].id };
        const framing = resolveDirectorViewFraming({ scene: { ...scene, cameras: [camera] }, mode: "camera", playhead: 1 });
        expect(framing?.position).toEqual([4.8, 2.7, 6.8]);
        expect(framing?.target).toEqual([1, 0.5, 0]);
    });

    test("手动旋转改变视线方向；目标删除后跟随和注视安全回落", () => {
        const scene = createDirectorReproScene();
        const camera = { ...scene.cameras[0], transform: { ...scene.cameras[0].transform, position: [0, 1, 5] as DirectorVec3, rotation: [0, Math.PI / 2, 0] as DirectorVec3 }, lookAtMode: "rotation" as const };
        const rotation = resolveDirectorViewFraming({ scene: { ...scene, cameras: [camera] }, mode: "camera", playhead: 0 });
        expect(rotation?.target[0]).toBeCloseTo(-1, 5);
        expect(rotation?.target[1]).toBeCloseTo(1, 5);
        expect(rotation?.target[2]).toBeCloseTo(5, 5);
        const deleted = { ...camera, lookAtMode: "object" as const, lookAtObjectId: "deleted", followObjectId: "deleted", followAnchor: [0, 0, 0] as DirectorVec3 };
        const fallback = resolveDirectorViewFraming({ scene: { ...scene, cameras: [deleted] }, mode: "camera", playhead: 0 });
        expect(fallback?.position).toEqual([0, 1, 5]);
        expect(fallback?.target).toEqual(camera.target);
    });

    test("摇镜/俯仰关键帧在 CAM 中改变注视方向且摄影机位置固定", () => {
        const scene = createDirectorReproScene();
        const base = { ...scene.cameras[0], transform: { ...scene.cameras[0].transform, position: [0, 1, 5] as DirectorVec3 }, target: [0, 1, 0] as DirectorVec3 };
        const panEnd = resolveDirectorCameraMoveTransform(base.transform, base.target, "pan_right");
        const panCamera = {
            ...base,
            lookAtMode: resolveDirectorCameraMoveLookAtMode(base.lookAtMode, "pan_right"),
            keyframes: resolveDirectorCameraMoveKeyframes([], base.transform, panEnd, 2),
        };
        const start = resolveDirectorCameraLocalFraming(scene, panCamera, 0);
        const end = resolveDirectorCameraLocalFraming(scene, panCamera, 2);
        expect(end?.position).toEqual(start?.position);
        expect(end?.target[0]).toBeGreaterThan(start?.target[0] || 0);

        const tiltEnd = resolveDirectorCameraMoveTransform(base.transform, base.target, "tilt_up");
        const tiltCamera = {
            ...base,
            lookAtMode: resolveDirectorCameraMoveLookAtMode(base.lookAtMode, "tilt_up"),
            keyframes: resolveDirectorCameraMoveKeyframes([], base.transform, tiltEnd, 2),
        };
        expect(resolveDirectorCameraLocalFraming(scene, tiltCamera, 2)?.target[1]).toBeGreaterThan(base.target[1]);
    });

    test("删除被跟随或注视的对象时只清理对应绑定", () => {
        const scene = createDirectorReproScene();
        const camera: DirectorCamera = {
            ...scene.cameras[0],
            followObjectId: "target-a",
            followAnchor: [1, 2, 3],
            lookAtMode: "object",
            lookAtObjectId: "target-b",
        };
        const withoutFollow = removeDirectorCameraBindingsForObject(camera, "target-a", scene, 0);
        expect(withoutFollow).toEqual({ ...camera, followObjectId: undefined, followAnchor: undefined });
        const withoutLookAt = removeDirectorCameraBindingsForObject(withoutFollow, "target-b", scene, 0);
        expect(withoutLookAt).toEqual({ ...withoutFollow, lookAtMode: "coordinates", lookAtObjectId: undefined });
        expect(removeDirectorCameraBindingsForObject(camera, "other", scene, 0)).toBe(camera);
    });

    test("自由视角机位辅助图形与 CAM 共用当前帧取景，且能解算非活动机位", () => {
        const scene = movedScene();
        const first = bindDirectorCameraFollow(scene.cameras[0], scene, scene.objects[0].id, 0);
        const second: DirectorCamera = { ...first, id: "other-camera", transform: { ...first.transform, position: [0, 2, 8] } };
        const withCameras = { ...scene, cameras: [first, second] };
        expect(resolveDirectorCameraLocalFraming(withCameras, first, 1)?.position).toEqual([5.8, 2.7, 6.8]);
        expect(resolveDirectorCameraLocalFraming(withCameras, second, 1)?.position).toEqual([1, 2, 8]);
        expect(resolveDirectorCameraLocalFraming(withCameras, first, 1)?.target).toEqual(resolveDirectorViewFraming({ scene: withCameras, mode: "camera", playhead: 1 })?.target);
    });

    test("解除跟随保留当前构图，并把位移叠加到已有机位关键帧", () => {
        const scene = movedScene();
        const base = scene.cameras[0];
        const camera: DirectorCamera = {
            ...base,
            keyframes: [
                { id: "c0", time: 0, transform: base.transform },
                { id: "c2", time: 2, transform: { ...base.transform, position: [6.8, 2.7, 6.8] } },
            ],
        };
        const bound = bindDirectorCameraFollow(camera, scene, scene.objects[0].id, 0);
        const before = resolveDirectorCameraLocalFraming(scene, bound, 1);
        const detached = unbindDirectorCameraFollow(bound, scene, 1);
        const after = resolveDirectorCameraLocalFraming(scene, detached, 1);
        expect(after?.position).toEqual(before?.position);
        expect(after?.target).toEqual(before?.target);
        expect(detached.followObjectId).toBeUndefined();
        expect(detached.followAnchor).toBeUndefined();
        expect(detached.keyframes.map((frame) => frame.transform.position[0])).toEqual([5.8, 7.8]);
        expect(detached.transform.position[0]).toBe(5.8);
    });

    test("删除被跟随兼注视的对象时保留删除瞬间的机位构图", () => {
        const scene = movedScene();
        const targetId = scene.objects[0].id;
        const followed = bindDirectorCameraFollow(scene.cameras[0], scene, targetId, 0);
        const camera: DirectorCamera = { ...followed, lookAtMode: "object", lookAtObjectId: targetId };
        const before = resolveDirectorCameraLocalFraming(scene, camera, 1);
        const detached = removeDirectorCameraBindingsForObject(camera, targetId, scene, 1);
        const after = resolveDirectorCameraLocalFraming({ ...scene, objects: scene.objects.filter((object) => object.id !== targetId) }, detached, 1);
        expect(after?.position).toEqual(before?.position);
        expect(after?.target).toEqual(before?.target);
        expect(detached.followObjectId).toBeUndefined();
        expect(detached.lookAtMode).toBe("coordinates");
    });

    test("从一个跟随目标切换到另一个目标时当前帧不跳变", () => {
        const scene = movedScene();
        const first = bindDirectorCameraFollow(scene.cameras[0], scene, scene.objects[0].id, 0);
        const before = resolveDirectorCameraLocalFraming(scene, first, 1);
        const switched = bindDirectorCameraFollow(first, scene, scene.objects[1].id, 1);
        const after = resolveDirectorCameraLocalFraming(scene, switched, 1);
        expect(after?.position).toEqual(before?.position);
        expect(after?.target).toEqual(before?.target);
        expect(switched.followObjectId).toBe(scene.objects[1].id);
    });
});
