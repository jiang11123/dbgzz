import { describe, expect, test } from "bun:test";

import { createDirectorActorPath, createDirectorActorPenPath, createDirectorActorPencilPath, editDirectorActorPathAtTime, removeDirectorActorPath, retimeDirectorActorPath, setDirectorActorPathFacing, updateDirectorActorPathTransform } from "@/lib/canvas/director/director-actor-paths";
import { createDirectorActor, interpolateDirectorTransform } from "@/lib/canvas/director/director-scene";

const actor = () => createDirectorActor("角色A", [0, 0, 0]);

describe("导演台角色运动轨迹", () => {
    test("直线路径从演员当前位置向前推进，播放头和输出读取同一组关键帧", () => {
        const source = actor();
        const result = createDirectorActorPath(source, "line", 10);
        expect(result.motionPath).toMatchObject({ kind: "line", duration: 10, facePath: true });
        expect(result.motionPath?.transform.position).toEqual([0, 0, 2]);
        expect(result.keyframes.map((key) => key.time)).toEqual([0, 10]);
        expect(interpolateDirectorTransform(result.transform, result.keyframes, 2).position).toEqual([0, 0, 0.8]);
        expect(interpolateDirectorTransform(result.transform, result.keyframes, 10).position).toEqual([0, 0, 4]);
    });

    test("更改轨迹时长保留空间路线但重定时关键帧", () => {
        const result = retimeDirectorActorPath(createDirectorActorPath(actor(), "line", 10), 5);
        expect(result.motionPath?.duration).toBe(5);
        expect(result.keyframes.map((key) => key.time)).toEqual([0, 5]);
        expect(interpolateDirectorTransform(result.transform, result.keyframes, 2.5).position).toEqual([0, 0, 2]);
    });

    test("轨迹属性只编辑播放头的插值位置，不移动整条路径", () => {
        const created = createDirectorActorPath(actor(), "line", 10);
        const edited = editDirectorActorPathAtTime(created, 2, { ...created.transform, position: [1, 0, 0.8] });
        expect(edited.keyframes).toHaveLength(3);
        expect(interpolateDirectorTransform(edited.transform, edited.keyframes, 0).position).toEqual([0, 0, 0]);
        expect(interpolateDirectorTransform(edited.transform, edited.keyframes, 2).position).toEqual([1, 0, 0.8]);
        expect(interpolateDirectorTransform(edited.transform, edited.keyframes, 10).position).toEqual([0, 0, 4]);
    });

    test("圆环和矩形路径的中心及半程站位与参考页一致", () => {
        const ring = createDirectorActorPath(actor(), "ring", 10);
        expect(ring.motionPath?.transform.position).toEqual([-2, 0, 0]);
        expect(interpolateDirectorTransform(ring.transform, ring.keyframes, 5).position[0]).toBeCloseTo(-4, 5);
        const rectangle = createDirectorActorPath(actor(), "rectangle", 10);
        expect(rectangle.motionPath?.transform.position).toEqual([2, 0, 1.5]);
        expect(interpolateDirectorTransform(rectangle.transform, rectangle.keyframes, 5).position).toEqual([4, 0, 3]);
    });

    test("圆环轨迹用平滑采样播放，但时间轴只暴露起点、半程和终点", () => {
        const ring = createDirectorActorPath(actor(), "ring", 10);
        expect(ring.keyframes.length).toBeGreaterThan(20);
        const controls = ring.keyframes.filter((frame) => ring.motionPath?.controlKeyframeIds?.includes(frame.id));
        expect(controls.map((frame) => frame.time)).toEqual([0, 5, 10]);
        for (const frame of ring.keyframes) {
            const [x, , z] = frame.transform.position;
            expect(Math.hypot(x + 2, z)).toBeCloseTo(2, 5);
        }
    });

    test("路径位置和等比缩放移动整条轨迹，不改变演员本身的身材比例", () => {
        const created = createDirectorActorPath(actor(), "line", 10);
        const shifted = updateDirectorActorPathTransform(created, { ...created.motionPath!.transform, position: [1, 0, 2] });
        expect(shifted.keyframes.map((key) => key.transform.position)).toEqual([[1, 0, 0], [1, 0, 4]]);
        const scaled = updateDirectorActorPathTransform(shifted, { ...shifted.motionPath!.transform, scale: [2, 2, 2] });
        expect(scaled.keyframes.map((key) => key.transform.position)).toEqual([[1, 0, -2], [1, 0, 6]]);
        expect(scaled.transform.scale).toEqual(created.transform.scale);
    });

    test("沿路径朝向只改变轨道旋转；关闭后恢复人物原始朝向", () => {
        const source = { ...actor(), transform: { ...actor().transform, rotation: [0, 0.4, 0] as [number, number, number] } };
        const ring = createDirectorActorPath(source, "ring", 10);
        expect(ring.keyframes.some((key) => key.transform.rotation[1] !== source.transform.rotation[1])).toBe(true);
        const unbound = setDirectorActorPathFacing(ring, false);
        expect(unbound.keyframes.every((key) => key.transform.rotation[1] === source.transform.rotation[1])).toBe(true);
    });

    test("移除轨迹时恢复创建前的关键帧，不清空用户原有动画", () => {
        const source = actor();
        const prior = [{ id: "manual", time: 1, transform: { ...source.transform, position: [3, 0, 0] as [number, number, number] } }];
        const withPath = createDirectorActorPath({ ...source, keyframes: prior }, "line", 10);
        expect(withPath.keyframes).not.toEqual(prior);
        const restored = removeDirectorActorPath(withPath);
        expect(restored.keyframes).toEqual(prior);
        expect(restored.motionPath).toBeUndefined();
    });

    test("铅笔轨迹按画布手势的空间距离分配时间，并以演员原位置起步", () => {
        const result = createDirectorActorPencilPath(actor(), [{ x: 5, z: 8 }, { x: 8, z: 8 }, { x: 8, z: 12 }], 7);
        expect(result?.motionPath).toMatchObject({ kind: "pencil", duration: 7 });
        expect(result?.keyframes).toHaveLength(10);
        expect(result?.keyframes[0].transform.position).toEqual([0, 0, 0]);
        expect(result?.keyframes[4].transform.position[0]).toBeCloseTo(3, 8);
        expect(result?.keyframes[4].transform.position[2]).toBeCloseTo(1 / 9, 8);
        expect(result?.keyframes.at(-1)?.transform.position).toEqual([3, 0, 4]);
        expect(result?.keyframes.every((frame, index) => Math.abs(frame.time - 7 * index / 9) < 1e-8)).toBe(true);
        expect(result?.motionPath?.transform.position).toEqual([1.5, 0, 2]);
    });

    test("铅笔单点手势不覆盖演员原有轨道", () => {
        expect(createDirectorActorPencilPath(actor(), [{ x: 5, z: 8 }, { x: 5, z: 8 }], 7)).toBeNull();
    });

    test("缓慢的小幅连续拖拽按累计位移采样，不会误判为单点", () => {
        const result = createDirectorActorPencilPath(actor(), [{ x: 0, z: 0 }, { x: 0.03, z: 0 }, { x: 0.06, z: 0 }, { x: 0.09, z: 0 }], 3);
        expect(result?.keyframes.at(-1)?.transform.position[0]).toBeCloseTo(0.09, 5);
    });

    test("钢笔逐点路径从演员位置出发、穿过控制点，并保留可编辑的控制时间点", () => {
        const result = createDirectorActorPenPath(actor(), [{ x: 2, z: 0 }, { x: 2, z: 2 }], 6);
        expect(result?.motionPath).toMatchObject({ kind: "pen", duration: 6 });
        expect(result?.motionPath?.transform.position).toEqual([1, 0, 1]);
        expect(result?.keyframes[0].transform.position).toEqual([0, 0, 0]);
        expect(result?.keyframes.at(-1)?.transform.position).toEqual([2, 0, 2]);
        expect(result?.keyframes.length).toBeGreaterThan(3);
        const controls = result!.keyframes.filter((frame) => result?.motionPath?.controlKeyframeIds?.includes(frame.id));
        expect(controls.map((frame) => frame.time)).toEqual([0, 3, 6]);
    });

    test("钢笔重复点击同一点不创建空动画", () => {
        expect(createDirectorActorPenPath(actor(), [{ x: 0, z: 0 }, { x: 0, z: 0 }], 6)).toBeNull();
    });
});
