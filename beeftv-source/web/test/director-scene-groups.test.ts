import { describe, expect, test } from "bun:test";
import * as sceneTools from "@/lib/canvas/director/director-scene";
import { createDirectorScene } from "@/lib/canvas/director/director-scene";
import { searchDirectorSceneItems } from "@/lib/canvas/director/director-scene-search";

describe("导演台场景对象分组", () => {
    test("分组把选中对象放入新分组，原有对象数据不变，列表中呈现父子层级", () => {
        const scene = createDirectorScene();
        scene.objects.push({ ...structuredClone(scene.objects[0]), id: "second-object", name: "演员 2" });
        const group = Reflect.get(sceneTools, "groupDirectorObjects") as ((scene: typeof scene, ids: string[]) => typeof scene) | undefined;
        expect(group).toBeFunction();
        const next = group!(scene, [scene.objects[0].id, "second-object"]);
        expect(next.groups).toHaveLength(1);
        expect(next.groups?.[0].name).toBe("分组1");
        expect(next.objects.filter((item) => item.groupId === next.groups?.[0].id).map((item) => item.id)).toEqual([scene.objects[0].id, "second-object"]);
        expect(scene.objects.every((item) => item.groupId === undefined)).toBe(true);
        expect(searchDirectorSceneItems(next, "").filter((item) => item.kind === "group" || item.kind === "object").map((item) => item.kind === "group" ? item.group.name : item.object.name)).toEqual(["分组1", "演员 1", "演员 2"]);
    });

    test("分组支持折叠与展开，并可解组而不删除对象", () => {
        const scene = createDirectorScene();
        scene.objects.push({ ...structuredClone(scene.objects[0]), id: "second-object", name: "演员 2" });
        const group = Reflect.get(sceneTools, "groupDirectorObjects") as ((scene: typeof scene, ids: string[]) => typeof scene) | undefined;
        const ungroup = Reflect.get(sceneTools, "ungroupDirectorObjects") as ((scene: typeof scene, id: string) => typeof scene) | undefined;
        const toggle = Reflect.get(sceneTools, "toggleDirectorGroupCollapsed") as ((scene: typeof scene, id: string) => typeof scene) | undefined;
        expect(group).toBeFunction();
        expect(ungroup).toBeFunction();
        expect(toggle).toBeFunction();
        const grouped = group!(scene, [scene.objects[0].id, "second-object"]);
        const id = grouped.groups![0].id;
        const collapsed = toggle!(grouped, id);
        expect(collapsed.groups?.[0].collapsed).toBe(true);
        expect(searchDirectorSceneItems(collapsed, "").filter((item) => item.kind === "object")).toHaveLength(0);
        const expanded = toggle!(collapsed, id);
        expect(searchDirectorSceneItems(expanded, "").filter((item) => item.kind === "object")).toHaveLength(2);
        const ungrouped = ungroup!(expanded, id);
        expect(ungrouped.groups).toBeUndefined();
        expect(ungrouped.objects.every((item) => item.groupId === undefined)).toBe(true);
        expect(ungrouped.objects).toHaveLength(2);
    });

    test("分组副本创建独立对象与父分组，显示和锁定操作统一作用于成员", () => {
        const scene = createDirectorScene();
        scene.objects.push({ ...structuredClone(scene.objects[0]), id: "second-object", name: "演员 2" });
        const group = Reflect.get(sceneTools, "groupDirectorObjects") as ((scene: typeof scene, ids: string[]) => typeof scene) | undefined;
        const duplicate = Reflect.get(sceneTools, "duplicateDirectorGroup") as ((scene: typeof scene, id: string) => typeof scene) | undefined;
        const visibility = Reflect.get(sceneTools, "toggleDirectorGroupVisibility") as ((scene: typeof scene, id: string) => typeof scene) | undefined;
        const locking = Reflect.get(sceneTools, "toggleDirectorGroupLock") as ((scene: typeof scene, id: string) => typeof scene) | undefined;
        expect(duplicate).toBeFunction();
        expect(visibility).toBeFunction();
        expect(locking).toBeFunction();
        const grouped = group!(scene, scene.objects.map((item) => item.id));
        const id = grouped.groups![0].id;
        const hidden = visibility!(grouped, id);
        expect(hidden.objects.every((item) => !item.visible)).toBe(true);
        const visible = visibility!(hidden, id);
        expect(visible.objects.every((item) => item.visible)).toBe(true);
        const locked = locking!(visible, id);
        expect(locked.objects.every((item) => item.locked)).toBe(true);
        const copy = duplicate!(locked, id);
        expect(copy.groups).toHaveLength(2);
        expect(copy.objects).toHaveLength(4);
        expect(copy.objects.slice(2).every((item) => item.groupId === copy.groups?.[1].id)).toBe(true);
        expect(new Set(copy.objects.map((item) => item.id)).size).toBe(4);
    });
});
