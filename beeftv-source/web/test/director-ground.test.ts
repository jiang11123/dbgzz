import { describe, expect, test } from "bun:test";
import { createDirectorScene } from "@/lib/canvas/director/director-scene";
import { createDirectorSceneFromTemplate } from "@/lib/canvas/director/director-templates";
import { DIRECTOR_DEFAULT_GROUND, directorGroundSettings } from "@/lib/canvas/director/director-ground";

describe("导演台地面", () => {
    test("新场景和模板使用 LibTV 地面初始值", () => {
        expect(createDirectorScene().ground).toEqual(DIRECTOR_DEFAULT_GROUND);
        expect(createDirectorSceneFromTemplate("empty").ground).toEqual(DIRECTOR_DEFAULT_GROUND);
    });

    test("旧场景缺少字段时保持原本不透明的地面", () => {
        expect(directorGroundSettings({})).toEqual({ visible: true, opacity: 1, height: 0 });
    });

    test("异常保存值不穿透到 3D 材质或几何体", () => {
        expect(directorGroundSettings({ ground: { visible: false, opacity: Infinity, height: NaN } })).toEqual({ visible: false, opacity: 1, height: 0 });
        expect(directorGroundSettings({ ground: { visible: true, opacity: -1, height: 100 } })).toEqual({ visible: true, opacity: 0, height: 2 });
    });
});
