import { describe, expect, test } from "bun:test";

import { resampleDirectorGroundPath } from "@/lib/canvas/director/director-path-sampling";

describe("导演台轨迹固定十点采样", () => {
    test("短于 0.5 米的路线也有十个等比例控制点", () => {
        const points = resampleDirectorGroundPath([{ x: 0, z: 0 }, { x: 0.2, z: 0 }]);

        expect(points).toHaveLength(10);
        points.forEach((point, index) => {
            expect(point.x).toBeCloseTo(0.2 * index / 9, 8);
            expect(point.z).toBe(0);
        });
    });

    test("折线路径按总弧长等分十点，并保留起点和终点", () => {
        const points = resampleDirectorGroundPath([{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 1, z: 1 }]);

        expect(points).toHaveLength(10);
        expect(points[0]).toEqual({ x: 0, z: 0 });
        expect(points.at(-1)).toEqual({ x: 1, z: 1 });
        expect(points[4].x).toBeCloseTo(8 / 9, 8);
        expect(points[4].z).toBe(0);
        expect(points[5].x).toBe(1);
        expect(points[5].z).toBeCloseTo(1 / 9, 8);
    });
});
