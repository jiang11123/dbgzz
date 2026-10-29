import { describe, expect, test } from "bun:test";
import { Color } from "three";

import { createDirectorScene } from "@/lib/canvas/director/director-scene";
import { directorStagePalette } from "@/lib/canvas/director/director-stage-palette";
import { createDirectorSceneFromTemplate } from "@/lib/canvas/director/director-templates";

describe("导演台新场景舞台色", () => {
    test("所有新模板默认深色舞台，旧场景背景不被改写", () => {
        expect(createDirectorScene().background).toBe("#060608");
        for (const template of ["empty", "monologue", "dialogue", "blocking", "product"] as const) {
            expect(createDirectorSceneFromTemplate(template).background).toBe("#060608");
        }
        expect(directorStagePalette("#d8dde3").ground).toBe("#aeb7bf");
    });

    test("深色场景用暗地面与可辨识网格，浅色旧场景维持原视觉", () => {
        const dark = directorStagePalette("#060608");
        const lightness = (color: string) => new Color(color).getHSL({ h: 0, s: 0, l: 0 }).l;
        expect(dark.ground).toBe("#151820");
        expect(lightness(dark.cell)).toBeGreaterThan(lightness(dark.ground));
        expect(lightness(dark.section)).toBeGreaterThan(lightness(dark.cell));
        expect(directorStagePalette("#d8dde3")).toEqual({ ground: "#aeb7bf", cell: "#8f99a3", section: "#626d77" });
    });
});
