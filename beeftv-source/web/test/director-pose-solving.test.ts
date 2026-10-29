import { describe, expect, test } from "bun:test";

import * as directorScene from "../src/lib/canvas/director/director-scene";

const poseApi = directorScene as unknown as {
    resolveDirectorPoseTargets: (pose: string, timeSeconds?: number) => {
        pelvisOffset: [number, number, number];
        hands?: Partial<Record<"leftHand" | "rightHand", [number, number, number]>>;
        feet?: Partial<Record<"leftFoot" | "rightFoot", [number, number, number]>>;
        knees?: Partial<Record<"leftKnee" | "rightKnee", [number, number, number]>>;
        period?: number;
    };
    resolveDirectorTwoBoneJoint: (start: [number, number, number], end: [number, number, number], upperLength: number, lowerLength: number, pole: [number, number, number]) => [number, number, number];
};

function distance(a: [number, number, number], b: [number, number, number]) {
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

describe("导演台语义姿势与 IK", () => {
    test("蹲下与跪姿显式降低骨盆并声明地面接触目标", () => {
        expect(typeof poseApi.resolveDirectorPoseTargets).toBe("function");
        const squat = poseApi.resolveDirectorPoseTargets("squat");
        const single = poseApi.resolveDirectorPoseTargets("kneel_single");
        const double = poseApi.resolveDirectorPoseTargets("kneel_double");

        expect(squat.pelvisOffset[1]).toBeLessThan(-0.2);
        expect(squat.feet?.leftFoot?.[1]).toBeGreaterThanOrEqual(0);
        expect(squat.feet?.rightFoot?.[1]).toBeGreaterThanOrEqual(0);
        expect(single.pelvisOffset[1]).toBeLessThan(-0.2);
        expect(Object.values(single.knees || {}).filter((point) => point[1] <= 0.08)).toHaveLength(1);
        expect(double.pelvisOffset[1]).toBeLessThan(-0.2);
        expect(double.knees?.leftKnee?.[1]).toBeLessThanOrEqual(0.08);
        expect(double.knees?.rightKnee?.[1]).toBeLessThanOrEqual(0.08);
    });

    test("接触型上肢姿势给出明确末端目标", () => {
        const think = poseApi.resolveDirectorPoseTargets("think");
        const crossed = poseApi.resolveDirectorPoseTargets("arms_crossed");
        const phone = poseApi.resolveDirectorPoseTargets("phone");
        const reach = poseApi.resolveDirectorPoseTargets("reach");

        expect(think.hands?.rightHand).toBeDefined();
        expect(think.hands!.rightHand![1]).toBeGreaterThan(1.1);
        expect(crossed.hands?.leftHand?.[0]).toBeGreaterThan(0);
        expect(crossed.hands?.rightHand?.[0]).toBeLessThan(0);
        expect(phone.hands?.leftHand?.[0]).toBeLessThan(0);
        expect(phone.hands?.rightHand?.[0]).toBeGreaterThan(0);
        expect(distance(phone.hands!.leftHand!, phone.hands!.rightHand!)).toBeLessThan(0.25);
        expect(reach.hands?.rightHand?.[2]).toBeGreaterThan(0.25);
    });

    test("跑步循环左右脚交替抬起并在一个周期后闭合", () => {
        const start = poseApi.resolveDirectorPoseTargets("run", 0);
        const half = poseApi.resolveDirectorPoseTargets("run", start.period! / 2);
        const end = poseApi.resolveDirectorPoseTargets("run", start.period!);

        expect(start.period).toBeGreaterThan(0);
        expect(start.feet!.leftFoot![1]).not.toBeCloseTo(half.feet!.leftFoot![1], 3);
        expect(start.feet!.leftFoot![1]).toBeCloseTo(half.feet!.rightFoot![1], 3);
        expect(distance(start.feet!.leftFoot!, end.feet!.leftFoot!)).toBeLessThan(1e-6);
        expect(distance(start.hands!.leftHand!, end.hands!.leftHand!)).toBeLessThan(1e-6);
    });

    test("两段 IK 在可达目标上保持两段骨长并朝极向量弯曲", () => {
        expect(typeof poseApi.resolveDirectorTwoBoneJoint).toBe("function");
        const start: [number, number, number] = [0, 1, 0];
        const end: [number, number, number] = [0.15, 0.1, 0];
        const elbow = poseApi.resolveDirectorTwoBoneJoint(start, end, 0.62, 0.5, [0, 0, 1]);

        expect(distance(start, elbow)).toBeCloseTo(0.62, 5);
        expect(distance(elbow, end)).toBeCloseTo(0.5, 5);
        expect(elbow[2]).toBeGreaterThan(0);
    });
});
