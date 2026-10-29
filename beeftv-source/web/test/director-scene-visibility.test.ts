import { describe, expect, test } from "bun:test";
import { createDirectorScene, toggleDirectorObjectVisibility } from "../src/lib/canvas/director/director-scene";

describe("导演台场景列表可见性", () => {
    test("隐藏与恢复只改变目标对象，保留列表中的对象和其他场景数据", () => {
        const scene = createDirectorScene();
        const target = scene.objects[0];
        const hidden = toggleDirectorObjectVisibility(scene, target.id);
        expect(hidden.objects).toHaveLength(scene.objects.length);
        expect(hidden.objects[0].visible).toBe(false);
        expect(hidden.objects.slice(1)).toEqual(scene.objects.slice(1));
        expect(scene.objects[0].visible).toBe(true);
        expect(toggleDirectorObjectVisibility(hidden, target.id).objects[0].visible).toBe(true);
    });

    test("对象不存在时不创建无效历史变更", () => {
        const scene = createDirectorScene();
        expect(toggleDirectorObjectVisibility(scene, "missing")).toBe(scene);
    });
});
