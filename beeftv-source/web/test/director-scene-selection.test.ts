import { describe, expect, test } from "bun:test";
import * as selection from "@/lib/canvas/director/director-scene-search";

const ids = ["camera-1", "camera-2", "actor-a", "actor-b"];

describe("导演台场景列表多选", () => {
    test("普通点击只选择当前行，Shift 点击选择从锚点到目标的连续范围", () => {
        const resolve = Reflect.get(selection, "resolveDirectorSceneSelection") as ((order: string[], current: string[], anchor: string | null, target: string, shift: boolean) => string[]) | undefined;
        expect(resolve).toBeFunction();
        expect(resolve!(ids, [], null, "actor-a", false)).toEqual(["actor-a"]);
        expect(resolve!(ids, ["actor-a"], "actor-a", "actor-b", true)).toEqual(["actor-a", "actor-b"]);
        expect(resolve!(ids, ["actor-a", "actor-b"], "actor-a", "camera-2", false)).toEqual(["camera-2"]);
    });

    test("过滤与删除后失效锚点不会引入不存在的对象", () => {
        const resolve = Reflect.get(selection, "resolveDirectorSceneSelection") as ((order: string[], current: string[], anchor: string | null, target: string, shift: boolean) => string[]) | undefined;
        expect(resolve).toBeFunction();
        expect(resolve!(["actor-b"], ["actor-a"], "actor-a", "actor-b", true)).toEqual(["actor-b"]);
    });
});
