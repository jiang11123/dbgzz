import { describe, expect, test } from "bun:test";

import { updateDirectorShotPrompt } from "@/lib/canvas/director/director-session";
import { createDirectorScene } from "@/lib/canvas/director/director-scene";

describe("导演节点描述提交", () => {
    test("更新指定镜头提示词并保留其它镜头内容", () => {
        const base = createDirectorScene("双镜头");
        const secondShot = { ...base.shots[0], id: "shot-2", name: "镜头 2", prompt: "旧描述 2" };
        const scene = { ...base, activeShotId: secondShot.id, shots: [{ ...base.shots[0], prompt: "旧描述 1" }, secondShot] };

        const updated = updateDirectorShotPrompt(scene, base.shots[0].id, "  新的场景描述  ");

        expect(updated.shots[0].prompt).toBe("新的场景描述");
        expect(updated.shots[1]).toBe(secondShot);
        expect(updated.activeShotId).toBe(secondShot.id);
    });

    test("镜头引用失效时回退活动镜头，空描述不覆盖已有内容", () => {
        const scene = createDirectorScene("单镜头");
        const fallback = updateDirectorShotPrompt(scene, "missing-shot", "新描述");
        expect(fallback.shots[0].prompt).toBe("新描述");
        expect(updateDirectorShotPrompt(fallback, scene.activeShotId, "   ")).toBe(fallback);
    });
});
