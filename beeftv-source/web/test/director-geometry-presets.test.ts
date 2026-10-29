import { describe, expect, test } from "bun:test";

import { createDirectorGeometricObject, DIRECTOR_GEOMETRY_PRESET_OPTIONS } from "../src/lib/canvas/director/director-geometry-presets";

describe("导演台几何模型预设", () => {
    test("exposes all geometric choices and creates the matching persistent scene primitive", () => {
        expect(DIRECTOR_GEOMETRY_PRESET_OPTIONS.map(({ label }) => label)).toEqual([
            "立方体", "球体", "圆柱体", "环状体", "圆锥", "棱锥", "添加空对象",
        ]);

        for (const option of DIRECTOR_GEOMETRY_PRESET_OPTIONS) {
            const object = createDirectorGeometricObject(option.id);
            expect(object).toMatchObject({ kind: "primitive", primitive: option.primitive, name: option.label, visible: true });
            expect(object.url).toBeUndefined();
        }
    });
});
