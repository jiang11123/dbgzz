import { describe, expect, test } from "bun:test";

import { applyDirectorUniformScale, createDirectorObject } from "../src/lib/canvas/director/director-scene";

describe("导演台统一缩放", () => {
    test("独立倍率按比例缩放三个轴及所有关键帧，不抹平原来的轴向差异", () => {
        const base = createDirectorObject("box", "道具");
        const object = {
            ...base,
            transform: { ...base.transform, scale: [1, 2, 3] as [number, number, number] },
            keyframes: [{ id: "k1", time: 1, transform: { ...base.transform, scale: [2, 3, 4] as [number, number, number] } }],
        };
        const doubled = applyDirectorUniformScale(object, 2);
        expect(doubled.uniformScale).toBe(2);
        expect(doubled.transform.scale).toEqual([2, 4, 6]);
        expect(doubled.keyframes[0].transform.scale).toEqual([4, 6, 8]);
        const tripled = applyDirectorUniformScale(doubled, 3);
        expect(tripled.transform.scale).toEqual([3, 6, 9]);
        expect(tripled.keyframes[0].transform.scale).toEqual([6, 9, 12]);
        expect(object.transform.scale).toEqual([1, 2, 3]);
    });

    test("旧对象倍率缺省为 1，越界与非法输入不写坏场景", () => {
        const object = createDirectorObject("box", "道具");
        expect(applyDirectorUniformScale(object, Number.NaN)).toBe(object);
        expect(applyDirectorUniformScale(object, 0).uniformScale).toBe(0.1);
        expect(applyDirectorUniformScale(object, 20).uniformScale).toBe(10);
    });
});
