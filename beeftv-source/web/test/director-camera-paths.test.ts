import { describe, expect, test } from "bun:test";

import { createDirectorCameraDrawnPathKeyframes, createDirectorCameraPathKeyframes, createDirectorMotionPresetKeyframes, recordDirectorCameraPositionAtTime, recordDirectorCameraRotationAtTime, retimeDirectorCameraPathKeyframes, switchDirectorCameraLookAtMode, updateDirectorCameraOpticsAtTime, updateDirectorCameraPropertyAtTime } from "@/lib/canvas/director/director-camera-paths";
import { createDirectorReproScene } from "@/lib/canvas/director/director-repro-fixture";
import { resolveDirectorCameraLocalFraming } from "@/lib/canvas/director/director-view-modes";
import { Vector3 } from "three";

describe("导演台主机位轨迹", () => {
    const camera = createDirectorReproScene().cameras[0];

    test("直线路径从当前机位出发，沿注视目标方向形成可播放的位移", () => {
        const keys = createDirectorCameraPathKeyframes("line", camera, 4);
        expect(keys.map((key) => key.time)).toEqual([0, 4]);
        expect(keys[0].transform.position).toEqual(camera.transform.position);
        expect(keys[1].transform.position[2]).toBeLessThan(camera.transform.position[2]);
        expect(keys.map((key) => key.target)).toEqual([camera.target, camera.target]);
        expect(keys.map((key) => key.fov)).toEqual([camera.fov, camera.fov]);
    });

    test("铅笔手势从原机位起步并沿拖拽轨迹移动，保留焦点、视角和高度", () => {
        const keys = createDirectorCameraDrawnPathKeyframes("pencil", camera, [{ x: 4, z: 8 }, { x: 6, z: 8 }, { x: 6, z: 12 }], 10);
        expect(keys).toHaveLength(10);
        keys?.[0].transform.position.forEach((value, axis) => expect(value).toBeCloseTo(camera.transform.position[axis], 5));
        keys?.[3].transform.position.forEach((value, axis) => expect(value).toBeCloseTo([6.8, 2.7, 6.8][axis], 5));
        keys?.at(-1)?.transform.position.forEach((value, axis) => expect(value).toBeCloseTo([6.8, 2.7, 10.8][axis], 5));
        expect(keys?.every((key, index) => Math.abs(key.time - 10 * index / 9) < 1e-8)).toBe(true);
        expect(keys?.every((key) => key.target?.every((value, index) => value === camera.target[index]) && key.fov === camera.fov)).toBe(true);
        expect(createDirectorCameraDrawnPathKeyframes("pencil", camera, [{ x: 1, z: 1 }], 10)).toBeNull();
    });

    test("钢笔逐点路线穿过控制点，双击点被重复采集也不产生空帧", () => {
        const keys = createDirectorCameraDrawnPathKeyframes("pen", camera, [{ x: 6, z: 6 }, { x: 6, z: 6 }, { x: 8, z: 4 }], 10);
        expect(keys?.length).toBeGreaterThan(10);
        expect(keys?.[0].transform.position).toEqual(camera.transform.position);
        expect(keys?.at(-1)?.transform.position).toEqual([8, 2.7, 4]);
        expect(keys?.at(-1)?.time).toBe(10);
        expect(createDirectorCameraDrawnPathKeyframes("pen", camera, [{ x: 6, z: 6 }, { x: 6, z: 6 }], 10)).toBeNull();
    });

    test("圆环和矩形路径闭合、保留机位高度，并在片段内分布关键帧", () => {
        for (const kind of ["ring", "rectangle"] as const) {
            const keys = createDirectorCameraPathKeyframes(kind, camera, 4);
            expect(keys.length).toBeGreaterThanOrEqual(5);
            expect(keys[0].time).toBe(0);
            expect(keys.at(-1)?.time).toBe(4);
            expect(keys.at(-1)?.transform.position).toEqual(keys[0].transform.position);
            expect(keys.every((key) => key.transform.position[1] === camera.transform.position[1])).toBe(true);
        }
    });

    test("修改镜头时长时按比例移动轨迹关键帧，不改变原位置和帧身份", () => {
        const keys = createDirectorCameraPathKeyframes("rectangle", camera, 4);
        const retimed = retimeDirectorCameraPathKeyframes(keys, 4, 8);
        expect(retimed.map((key) => key.time)).toEqual([0, 2, 4, 6, 8]);
        expect(retimed.map((key) => key.id)).toEqual(keys.map((key) => key.id));
        expect(retimed.map((key) => key.transform.position)).toEqual(keys.map((key) => key.transform.position));
    });

    test("替换推近写入两秒运镜，追加横移从前段末尾无跳帧地继续", () => {
        const replaced = createDirectorMotionPresetKeyframes("push_in", "replace", camera, 4);
        expect(replaced.keyframes.map((key) => key.time)).toEqual([0, 2]);
        expect(replaced.keyframes[1].transform.position[2]).toBeLessThan(camera.transform.position[2]);
        const appended = createDirectorMotionPresetKeyframes("truck", "append", { ...camera, keyframes: replaced.keyframes }, 4);
        expect(appended.keyframes.map((key) => key.time)).toEqual([0, 2, 4]);
        expect(appended.keyframes[1].id).toBe(replaced.keyframes[1].id);
        expect(appended.keyframes[2].transform.position[0]).not.toBe(appended.keyframes[1].transform.position[0]);
        expect(appended.duration).toBe(4);
    });

    test("追加运镜超过当前镜头时长时延长镜头，环绕和螺旋有多段空间采样", () => {
        const first = createDirectorMotionPresetKeyframes("orbit", "replace", camera, 4);
        expect(first.keyframes.length).toBeGreaterThan(3);
        const second = createDirectorMotionPresetKeyframes("spiral", "append", { ...camera, keyframes: first.keyframes }, 4);
        expect(second.duration).toBe(4);
        expect(second.keyframes.at(-1)?.transform.position[1]).toBeGreaterThan(camera.transform.position[1]);
        const third = createDirectorMotionPresetKeyframes("lift", "append", { ...camera, keyframes: second.keyframes }, 4);
        expect(third.duration).toBe(6);
        expect(third.keyframes.at(-1)?.time).toBe(6);
    });

    test("预设写出位置、焦点和视角三轨，追加段继承上一段末帧光学状态", () => {
        const replaced = createDirectorMotionPresetKeyframes("push_in", "replace", camera, 4);
        expect(replaced.keyframes.map((key) => key.target)).toEqual([camera.target, camera.target]);
        expect(replaced.keyframes.map((key) => key.fov)).toEqual([camera.fov, camera.fov]);
        const customized = replaced.keyframes.map((key, index) => index === 1 ? { ...key, target: [1, 1.2, 0] as [number, number, number], fov: 35 } : key);
        const appended = createDirectorMotionPresetKeyframes("truck", "append", { ...camera, keyframes: customized }, 4);
        expect(appended.keyframes[1].target).toEqual([1, 1.2, 0]);
        expect(appended.keyframes[2].target).toEqual([1, 1.2, 0]);
        expect(appended.keyframes[2].fov).toBe(35);
    });

    test("在播放头编辑焦点与视角只改当前相机帧，并保留相邻帧和基准机位", () => {
        const preset = createDirectorMotionPresetKeyframes("push_in", "replace", camera, 4);
        const edited = updateDirectorCameraOpticsAtTime({ ...camera, keyframes: preset.keyframes }, 1, 1, { target: [1, 1.2, 0], fov: 35 });
        expect(edited.keyframes.map((key) => key.time)).toEqual([0, 1, 2]);
        expect(edited.keyframes[1].target).toEqual([1, 1.2, 0]);
        expect(edited.keyframes[1].fov).toBe(35);
        expect(edited.keyframes[2].id).toBe(preset.keyframes[1].id);
        expect(edited.target).toEqual(camera.target);
        expect(edited.fov).toBe(camera.fov);
        expect(edited.lookAtMode).toBe("coordinates");
    });

    test("只编辑焦点不凭空创建视角帧，之后编辑视角可复用同一时刻的焦点帧", () => {
        const preset = createDirectorMotionPresetKeyframes("push_in", "replace", camera, 4);
        const focusOnly = updateDirectorCameraOpticsAtTime({ ...camera, keyframes: preset.keyframes }, 1, 1, { target: [1, 1.2, 0] });
        expect(focusOnly.keyframes[1].target).toEqual([1, 1.2, 0]);
        expect(focusOnly.keyframes[1].fov).toBeUndefined();
        expect(focusOnly.keyframes[1].positionKeyed).toBe(false);
        const withFov = updateDirectorCameraOpticsAtTime(focusOnly, 1, 1, { fov: 35 });
        expect(withFov.keyframes).toHaveLength(3);
        expect(withFov.keyframes[1].id).toBe(focusOnly.keyframes[1].id);
        expect(withFov.keyframes[1].target).toEqual([1, 1.2, 0]);
        expect(withFov.keyframes[1].fov).toBe(35);
    });

    test("属性面板在运镜中只改播放头帧，静态机位则仍改基础值", () => {
        const preset = createDirectorMotionPresetKeyframes("push_in", "replace", camera, 4);
        const animated = { ...camera, keyframes: preset.keyframes };
        const target = updateDirectorCameraPropertyAtTime(animated, 1, 1, { target: [2, 1.2, 0] });
        expect(target.target).toEqual(camera.target);
        expect(target.keyframes[1].target).toEqual([2, 1.2, 0]);
        expect(target.keyframes[1].positionKeyed).toBe(false);
        expect(target.keyframes[0]).toEqual(preset.keyframes[0]);
        const position = updateDirectorCameraPropertyAtTime(target, 1, 1, { transform: { ...camera.transform, position: [2, 3, 4] } });
        expect(position.transform).toEqual(camera.transform);
        expect(position.keyframes[1].positionKeyed).toBe(true);
        expect(position.keyframes[1].transform.position).toEqual([2, 3, 4]);
        const fov = updateDirectorCameraPropertyAtTime(position, 1, 1, { fov: 35 });
        expect(fov.fov).toBe(camera.fov);
        expect(fov.keyframes[1].fov).toBe(35);
        const staticFov = updateDirectorCameraPropertyAtTime(camera, 1, 1, { fov: 35 });
        expect(staticFov.fov).toBe(35);
        expect(staticFov.keyframes).toEqual([]);
    });

    test("空轨道点击位置菱形会创建第一帧，不顺手创建焦点和视角", () => {
        const keyed = recordDirectorCameraPositionAtTime(camera, 0, 0);
        expect(keyed.keyframes).toHaveLength(1);
        expect(keyed.keyframes[0].positionKeyed).toBe(true);
        expect(keyed.keyframes[0].target).toBeUndefined();
        expect(keyed.keyframes[0].fov).toBeUndefined();
        expect(keyed.transform).toEqual(camera.transform);
    });

    test("空轨道点击旋转菱形只创建旋转帧，已有位置帧则复用帧身份", () => {
        const rotation: [number, number, number] = [0.2, 0.4, 0];
        const keyed = recordDirectorCameraRotationAtTime(camera, 0, 0, rotation);
        expect(keyed.keyframes).toHaveLength(1);
        expect(keyed.keyframes[0].positionKeyed).toBe(false);
        expect(keyed.keyframes[0].rotationKeyed).toBe(true);
        expect(keyed.keyframes[0].transform.rotation).toEqual(rotation);
        expect(keyed.keyframes[0].target).toBeUndefined();
        const positioned = recordDirectorCameraPositionAtTime(camera, 0, 0);
        const both = recordDirectorCameraRotationAtTime(positioned, 0, 0, rotation);
        expect(both.keyframes).toHaveLength(1);
        expect(both.keyframes[0].id).toBe(positioned.keyframes[0].id);
        expect(both.keyframes[0].positionKeyed).toBe(true);
        expect(both.keyframes[0].rotationKeyed).toBe(true);
    });

    test("手动坐标与手动旋转互切时保留当前可见视线", () => {
        const scene = createDirectorReproScene();
        const initial = { ...scene.cameras[0], transform: { ...scene.cameras[0].transform, position: [0, 1.91, 7.6] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] }, target: [0, 1.2, 0] as [number, number, number], lookAtMode: "coordinates" as const };
        const direction = (current: typeof initial) => {
            const frame = resolveDirectorCameraLocalFraming({ ...scene, cameras: [current] }, current, 0)!;
            return new Vector3(...frame.target).sub(new Vector3(...frame.position)).normalize();
        };
        const before = direction(initial);
        const rotated = switchDirectorCameraLookAtMode({ ...scene, cameras: [initial] }, initial, 0, 0, "rotation");
        expect(rotated.lookAtMode).toBe("rotation");
        expect(direction(rotated).distanceTo(before)).toBeLessThan(1e-5);
        const coordinates = switchDirectorCameraLookAtMode({ ...scene, cameras: [rotated] }, rotated, 0, 0, "coordinates");
        expect(coordinates.lookAtMode).toBe("coordinates");
        expect(direction(coordinates).distanceTo(before)).toBeLessThan(1e-5);
        expect(coordinates.keyframes).toEqual([]);
    });
});
