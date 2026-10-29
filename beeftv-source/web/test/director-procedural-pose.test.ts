import { describe, expect, test } from "bun:test";

import { DIRECTOR_PROCEDURAL_ACTOR_BONES, DIRECTOR_PROCEDURAL_ACTOR_SKELETON_EDGES, resolveDirectorProceduralActorPose } from "../src/lib/canvas/director/director-procedural-pose";
import { resolveDirectorActorShape } from "../src/lib/canvas/director/director-actor-presets";

function distance(left: [number, number, number], right: [number, number, number]) {
    return Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
}

describe("离线程序角色姿态", () => {
    test("程序化人偶关键帧覆盖求解姿势与手动值，局部读数和网格使用同一旋转", () => {
        const keyed: [number, number, number, number] = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
        const frame = resolveDirectorProceduralActorPose("phone", { rightHand: [0, 0, 0, 1] }, undefined, 0.5, [{ bone: "rightHand", keyframes: [{ id: "hand-key", time: 0.5, rotation: keyed }] }]);
        frame.rotations.rightHand.forEach((value, index) => expect(value).toBeCloseTo(keyed[index], 6));
    });

    test("接触型预设把程序化人偶的手脚放到共享目标，并让跑步随时间循环", () => {
        const think = resolveDirectorProceduralActorPose("think").joints.rightHand;
        const phone = resolveDirectorProceduralActorPose("phone").joints;
        const squat = resolveDirectorProceduralActorPose("squat").joints;
        const runStart = resolveDirectorProceduralActorPose("run", {}, undefined, 0).joints.leftFoot;
        const runHalf = resolveDirectorProceduralActorPose("run", {}, undefined, 0.4).joints.leftFoot;

        expect(think[1]).toBeGreaterThan(1.1);
        expect(phone.leftHand[0]).toBeLessThan(0);
        expect(phone.rightHand[0]).toBeGreaterThan(0);
        expect(squat.hips[1]).toBeLessThan(resolveDirectorProceduralActorPose("stand").joints.hips[1]);
        expect(runStart[1]).not.toBeCloseTo(runHalf[1], 3);
    });

    test("20 个姿势数据能驱动人偶关节位置，而不是只改变检查器标签", () => {
        const stand = resolveDirectorProceduralActorPose("stand");
        const wave = resolveDirectorProceduralActorPose("wave");

        expect(distance(stand.joints.rightHand, wave.joints.rightHand)).toBeGreaterThan(0.25);
        expect(wave.joints.leftHand).toEqual(stand.joints.leftHand);
        expect(DIRECTOR_PROCEDURAL_ACTOR_BONES).toContain("head");
        expect(DIRECTOR_PROCEDURAL_ACTOR_BONES).toContain("leftUpperArm");
    });

    test("局部骨骼覆盖沿层级传递到末端关节", () => {
        const stand = resolveDirectorProceduralActorPose("stand");
        const rotated = resolveDirectorProceduralActorPose("stand", { leftUpperArm: [0, 0, Math.SQRT1_2, Math.SQRT1_2] });

        expect(distance(stand.joints.leftHand, rotated.joints.leftHand)).toBeGreaterThan(0.15);
        expect(distance(stand.joints.rightHand, rotated.joints.rightHand)).toBeLessThan(0.001);
    });

    test("自制人偶左右外展沿各自的外侧移动，前举进入镜头前方", () => {
        const stand = resolveDirectorProceduralActorPose("stand");
        const zRotation = (angle: number): [number, number, number, number] => [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)];
        const leftAbducted = resolveDirectorProceduralActorPose("stand", { leftUpperArm: zRotation(-0.35), leftUpperLeg: zRotation(-0.35) });
        const rightAbducted = resolveDirectorProceduralActorPose("stand", { rightUpperArm: zRotation(0.35), rightUpperLeg: zRotation(0.35) });
        const leftRaisedForward = resolveDirectorProceduralActorPose("stand", { leftUpperArm: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2] });
        const rightRaisedForward = resolveDirectorProceduralActorPose("stand", { rightUpperArm: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2] });

        expect(leftAbducted.joints.leftHand[0]).toBeLessThan(stand.joints.leftHand[0]);
        expect(rightAbducted.joints.rightHand[0]).toBeGreaterThan(stand.joints.rightHand[0]);
        expect(leftAbducted.joints.leftFoot[0]).toBeLessThan(stand.joints.leftFoot[0]);
        expect(rightAbducted.joints.rightFoot[0]).toBeGreaterThan(stand.joints.rightFoot[0]);
        expect(leftRaisedForward.joints.leftHand[2]).toBeGreaterThan(stand.joints.leftHand[2]);
        expect(rightRaisedForward.joints.rightHand[2]).toBeGreaterThan(stand.joints.rightHand[2]);
    });

    test("选中人偶的骨架拓扑覆盖躯干、双臂和双腿，且每条边都连接有效关节", () => {
        const joints = resolveDirectorProceduralActorPose("stand").joints;
        const edges = DIRECTOR_PROCEDURAL_ACTOR_SKELETON_EDGES;

        expect(edges).toContainEqual(["spine", "chest"]);
        expect(edges).toContainEqual(["leftUpperArm", "leftLowerArm"]);
        expect(edges).toContainEqual(["rightUpperArm", "rightLowerArm"]);
        expect(edges).toContainEqual(["leftUpperLeg", "leftLowerLeg"]);
        expect(edges).toContainEqual(["rightUpperLeg", "rightLowerLeg"]);
        expect(edges.length).toBeGreaterThanOrEqual(18);
        expect(edges.every(([from, to]) => Boolean(joints[from] && joints[to]))).toBe(true);
    });

    test("不同预设改变骨架实际长度与肩距，脚仍落在地面附近", () => {
        const male = resolveDirectorProceduralActorPose("stand", {}, resolveDirectorActorShape("standard_male"));
        const athletic = resolveDirectorProceduralActorPose("stand", {}, resolveDirectorActorShape("athletic"));
        const slim = resolveDirectorProceduralActorPose("stand", {}, resolveDirectorActorShape("slim"));
        const child = resolveDirectorProceduralActorPose("stand", {}, resolveDirectorActorShape("child"));
        const chibi = resolveDirectorProceduralActorPose("stand", {}, resolveDirectorActorShape("chibi"));
        expect(distance(athletic.joints.leftShoulder, athletic.joints.rightShoulder)).toBeGreaterThan(distance(male.joints.leftShoulder, male.joints.rightShoulder));
        expect(distance(slim.joints.leftUpperArm, slim.joints.leftHand)).toBeGreaterThan(distance(male.joints.leftUpperArm, male.joints.leftHand));
        expect(child.joints.head[1]).toBeLessThan(male.joints.head[1]);
        expect(chibi.joints.head[1]).toBeLessThan(child.joints.head[1]);
        for (const frame of [male, athletic, slim, child, chibi]) {
            expect(frame.joints.leftFoot[1]).toBeGreaterThan(0);
            expect(frame.joints.leftFoot[1]).toBeLessThan(0.1);
            expect(frame.joints.leftFoot[1]).toBeCloseTo(frame.joints.rightFoot[1]);
        }
    });
});
