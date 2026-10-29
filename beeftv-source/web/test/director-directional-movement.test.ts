import { describe, expect, test } from "bun:test";

import { resolveDirectorDirectionalNudge } from "../src/lib/canvas/director/director-animation-semantics";
import { resolveDirectorProceduralActorPose } from "../src/lib/canvas/director/director-procedural-pose";

describe("导演台方向键演员移动", () => {
    test("四向移动只改变地面位置，并让演员朝移动方向转身", () => {
        const start = { position: [2, 1, 3] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] };
        const forward = resolveDirectorDirectionalNudge(start, "up", 0.25, true);
        const left = resolveDirectorDirectionalNudge(start, "left", 0.25, true);

        expect(forward.position).toEqual([2, 1, 2.75]);
        expect(forward.rotation[1]).toBeCloseTo(Math.PI, 6);
        expect(left.position).toEqual([1.75, 1, 3]);
        expect(left.rotation[1]).toBeCloseTo(-Math.PI / 2, 6);
        expect(forward.position[1]).toBe(start.position[1]);
    });

    test("机位方向键移动保留朝向，只允许专用垂直命令改变高度", () => {
        const start = { position: [1, 2, 3] as [number, number, number], rotation: [0.1, 0.2, 0.3] as [number, number, number], scale: [1, 1, 1] as [number, number, number] };
        const right = resolveDirectorDirectionalNudge(start, "right", 0.1, false);
        const up = resolveDirectorDirectionalNudge(start, "up", 0.1, false);

        expect(right.position[0]).toBeCloseTo(1 + Math.cos(0.2) * 0.1, 6);
        expect(right.position[2]).toBeCloseTo(3 - Math.sin(0.2) * 0.1, 6);
        expect(up.position[0]).toBeCloseTo(1 - Math.sin(0.2) * 0.1, 6);
        expect(up.position[2]).toBeCloseTo(3 - Math.cos(0.2) * 0.1, 6);
        expect(right.rotation).toEqual(start.rotation);
        expect(up.rotation).toEqual(start.rotation);
    });

    test("演员四方向始终按舞台世界轴移动，不被上一步转身方向带偏", () => {
        const start = { position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] };
        const turnedForward = resolveDirectorDirectionalNudge(start, "up", 0.5, true);
        const thenRight = resolveDirectorDirectionalNudge(turnedForward, "right", 0.5, true);

        expect(turnedForward.position).toEqual([0, 0, -0.5]);
        expect(thenRight.position).toEqual([0.5, 0, -0.5]);
        expect(thenRight.rotation[1]).toBeCloseTo(Math.PI / 2, 6);
    });

    test("机位沿自身水平朝向移动，转过 90 度后方向与舞台轴正确对应", () => {
        const start = { position: [0, 1, 0] as [number, number, number], rotation: [0, Math.PI / 2, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] };
        const forward = resolveDirectorDirectionalNudge(start, "up", 1, false);
        const strafe = resolveDirectorDirectionalNudge(start, "right", 1, false);

        expect(forward.position[0]).toBeCloseTo(-1, 6);
        expect(forward.position[2]).toBeCloseTo(0, 6);
        expect(strafe.position[0]).toBeCloseTo(0, 6);
        expect(strafe.position[2]).toBeCloseTo(-1, 6);
        expect(forward.rotation).toEqual(start.rotation);
    });

    test("人物移动后清除旧的倾斜角，保持直立并转向新方向", () => {
        const leaning = { position: [0, 0.4, 0] as [number, number, number], rotation: [0.3, 1.2, -0.2] as [number, number, number], scale: [1, 1, 1] as [number, number, number] };
        const moved = resolveDirectorDirectionalNudge(leaning, "right", 0.5, true);

        expect(moved.rotation).toEqual([0, Math.PI / 2, 0]);
        expect(moved.position[1]).toBe(0.4);
    });

    test("默认站姿左右手对称，足部保持水平", () => {
        const { joints } = resolveDirectorProceduralActorPose("stand");

        expect(joints.leftHand[0]).toBeCloseTo(-joints.rightHand[0], 5);
        expect(joints.leftHand[1]).toBeCloseTo(joints.rightHand[1], 5);
        expect(joints.leftHand[1]).toBeLessThan(joints.leftShoulder[1]);
        expect(joints.rightHand[1]).toBeLessThan(joints.rightShoulder[1]);
        expect(joints.leftFoot[0]).toBeCloseTo(-joints.rightFoot[0], 5);
        expect(joints.leftFoot[1]).toBeCloseTo(joints.rightFoot[1], 5);
    });

    test("父骨骼姿势旋转累计到躯干的世界朝向", () => {
        const bow = resolveDirectorProceduralActorPose("bow");
        expect(bow.worldRotations.chest).not.toEqual(bow.rotations.chest);
        expect(bow.worldRotations.head).not.toEqual(bow.rotations.head);
    });
});
