import { describe, expect, test } from "bun:test";
import { createDirectorScene, toggleDirectorObjectLock } from "../src/lib/canvas/director/director-scene";

describe("导演台场景对象锁定", () => {
    test("锁定可撤销、可解锁，旧场景缺省未锁且不影响对象的变换数据", () => {
        const scene = createDirectorScene();
        const object = scene.objects[0];
        expect(object.locked).toBeUndefined();
        const locked = toggleDirectorObjectLock(scene, object.id);
        expect(locked.objects[0].locked).toBe(true);
        expect(locked.objects[0].transform).toEqual(object.transform);
        expect(scene.objects[0].locked).toBeUndefined();
        expect(toggleDirectorObjectLock(locked, object.id).objects[0].locked).toBe(false);
    });

    test("不存在的对象不产生场景变更", () => {
        const scene = createDirectorScene();
        expect(toggleDirectorObjectLock(scene, "missing")).toBe(scene);
    });
});
