import { describe, expect, test } from "bun:test";

import { searchDirectorSceneItems } from "@/lib/canvas/director/director-scene-search";
import { createDirectorSceneFromTemplate } from "@/lib/canvas/director/director-templates";

const scene = createDirectorSceneFromTemplate("dialogue");
scene.cameras[0].name = "机位2";
scene.objects[0].name = "角色A";
scene.objects[1].name = "角色B";

describe("导演台场景搜索", () => {
    test("空查询按机位、对象、灯光顺序列出场景数据", () => {
        const items = searchDirectorSceneItems(scene, "");
        expect(items.map((item) => item.name).slice(0, 3)).toEqual(["机位2", "角色A", "角色B"]);
        expect(items.some((item) => item.kind === "light")).toBe(true);
    });

    test("输入时只显示名称匹配项，忽略首尾空白和英文大小写", () => {
        expect(searchDirectorSceneItems(scene, "  机位2  ").map((item) => item.name)).toEqual(["机位2"]);
        expect(searchDirectorSceneItems(scene, "角色").map((item) => item.name)).toEqual(["角色A", "角色B"]);
        expect(searchDirectorSceneItems(scene, "not-found")).toEqual([]);
    });

    test("搜索只读，不更改项目场景", () => {
        const before = JSON.stringify(scene);
        searchDirectorSceneItems(scene, "角色A");
        expect(JSON.stringify(scene)).toBe(before);
    });
});
