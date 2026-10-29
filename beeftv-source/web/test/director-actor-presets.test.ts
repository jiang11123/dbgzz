import { describe, expect, test } from "bun:test";

import { createDirectorActorCrowd, createDirectorActorPreset, DIRECTOR_ACTOR_PRESET_OPTIONS, resolveDirectorActorShape, resolveDirectorCapsuleShape } from "../src/lib/canvas/director/director-actor-presets";
import { createDirectorActor, createDirectorScene } from "../src/lib/canvas/director/director-scene";
import { createDirectorSceneFromTemplate } from "../src/lib/canvas/director/director-templates";
import { createDirectorReproActorScene } from "../src/lib/canvas/director/director-repro-fixture";
import { DIRECTOR_QUATERNIUS_FEMALE_URL, DIRECTOR_QUATERNIUS_MALE_URL, resolveDirectorBuiltInActorUrl } from "../src/lib/canvas/director/director-actor-assets";

describe("导演台角色预设", () => {
    test("新建角色只提供标准男女与几何模型，其余体型仅供旧场景兼容", () => {
        expect(DIRECTOR_ACTOR_PRESET_OPTIONS.map((option) => option.label)).toEqual([
            "标准男性",
            "标准女性",
            "几何模型",
        ]);
    });

    test("标准女性使用随包提供的 Quaternius 女性模型", () => {
        const actor = createDirectorActorPreset("standard_female", "标准女性 1");

        expect(actor).toMatchObject({ kind: "actor", actorPreset: "standard_female", name: "标准女性 1", color: "#4f8ef7", visible: true, pose: "stand" });
        expect(actor.url).toBe(DIRECTOR_QUATERNIUS_FEMALE_URL);
        expect(actor.storageKey).toBeUndefined();
        expect(actor.assetId).toBeUndefined();
        expect(actor.rig).toEqual({ status: "unmapped", boneMap: {}, animationNames: [] });
    });

    test("默认演员和标准男性预设都使用本地 Quaternius 男性模型", () => {
        const actor = createDirectorActor("演员 1");
        expect(actor.actorPreset).toBe("standard_male");
        expect(actor.url).toBe(DIRECTOR_QUATERNIUS_MALE_URL);
        expect(createDirectorActorPreset("standard_male").url).toBe(DIRECTOR_QUATERNIUS_MALE_URL);
        expect(actor.pose).toBe("stand");
    });

    test("新建标准角色和单人导演台场景沿用参考页的蓝色，已有颜色仍可单独指定", () => {
        expect(createDirectorActor().color).toBe("#4f8ef7");
        expect(createDirectorActorPreset("standard_male").color).toBe("#4f8ef7");
        expect(createDirectorScene().objects[0].color).toBe("#4f8ef7");
        expect(createDirectorSceneFromTemplate("monologue").objects[0].color).toBe("#4f8ef7");
        expect(createDirectorReproActorScene().objects[0].color).toBe("#4f8ef7");
        expect(createDirectorActor("自定义", [0, 0, 0], "#d84949").color).toBe("#d84949");
    });

    test("旧场景的无 URL 人体预设解析到内置骨骼模型，几何模型仍独立", () => {
        expect(resolveDirectorBuiltInActorUrl(undefined)).toBe(DIRECTOR_QUATERNIUS_MALE_URL);
        expect(resolveDirectorBuiltInActorUrl("standard_male")).toBe(DIRECTOR_QUATERNIUS_MALE_URL);
        expect(resolveDirectorBuiltInActorUrl("standard_female")).toBe(DIRECTOR_QUATERNIUS_FEMALE_URL);
        expect(resolveDirectorBuiltInActorUrl("slim")).toBe(DIRECTOR_QUATERNIUS_MALE_URL);
        expect(resolveDirectorBuiltInActorUrl("child")).toBe(DIRECTOR_QUATERNIUS_MALE_URL);
        expect(resolveDirectorBuiltInActorUrl("geometric")).toBeNull();
        expect(createDirectorActorPreset("slim").url).toBe(DIRECTOR_QUATERNIUS_MALE_URL);
        expect(createDirectorActorPreset("slim").name).toBe("纤细");
    });

    test("builds one named 3-by-3 crowd with nine distinct local male actors", () => {
        const crowd = createDirectorActorCrowd();

        expect(crowd).toHaveLength(9);
        expect(new Set(crowd.map((actor) => actor.id)).size).toBe(9);
        expect(crowd.map((actor) => actor.name)).toEqual([
            "群众 1-1", "群众 1-2", "群众 1-3", "群众 1-4", "群众 1-5",
            "群众 1-6", "群众 1-7", "群众 1-8", "群众 1-9",
        ]);
        expect(crowd.every((actor) => actor.kind === "actor" && actor.actorPreset === "standard_male" && actor.color === "#4f8ef7" && actor.url === DIRECTOR_QUATERNIUS_MALE_URL)).toBe(true);
    });

    test("builds a centered crowd using the requested row, column, and spacing values", () => {
        const crowd = createDirectorActorCrowd(2, 2, 3, 2);

        expect(crowd).toHaveLength(6);
        expect(crowd.map((actor) => actor.transform.position)).toEqual([
            [-2, 0, -1], [0, 0, -1], [2, 0, -1],
            [-2, 0, 1], [0, 0, 1], [2, 0, 1],
        ]);
        expect(crowd.map((actor) => actor.name)).toEqual([
            "群众 2-1", "群众 2-2", "群众 2-3", "群众 2-4", "群众 2-5", "群众 2-6",
        ]);
    });

    test("fits rounded limb caps inside both short and long skeleton segments", () => {
        const shortSegment = resolveDirectorCapsuleShape(0.16, 0.09);
        const longSegment = resolveDirectorCapsuleShape(0.35, 0.09);

        expect(shortSegment.radius).toBe(0.08);
        expect(shortSegment.cylinderHeight).toBe(0);
        expect(shortSegment.cylinderHeight + 2 * shortSegment.radius).toBeCloseTo(0.16);
        expect(longSegment.radius).toBe(0.09);
        expect(longSegment.cylinderHeight + 2 * longSegment.radius).toBeCloseTo(0.35);
    });

    test("named body types resolve to distinct, plausible proportions while preserving the same ground scale", () => {
        const standard = resolveDirectorActorShape("standard_male");
        const female = resolveDirectorActorShape("standard_female");
        const athletic = resolveDirectorActorShape("athletic");
        const slim = resolveDirectorActorShape("slim");
        const child = resolveDirectorActorShape("child");
        const chibi = resolveDirectorActorShape("chibi");

        expect(female.shoulders).toBeLessThan(standard.shoulders);
        expect(female.waist).toBeLessThan(female.hips);
        expect(athletic.shoulders).toBeGreaterThan(athletic.waist);
        expect(slim.limbs).toBeLessThan(standard.limbs);
        expect(child.legLength).toBeLessThan(standard.legLength);
        expect(child.torsoLength).toBeLessThan(standard.torsoLength);
        expect(child.head).toBeGreaterThan(standard.head);
        expect(chibi.head).toBeGreaterThan(child.head);
        expect(standard.scale[1]).toBe(1);
        expect(new Set([standard, female, athletic, slim, child, chibi].map((shape) => `${shape.scale.join(",")}:${shape.shoulders}:${shape.waist}:${shape.hips}:${shape.head}:${shape.limbs}`)).size).toBe(6);
    });

    test("keeps stylized feet forward and reserves reduced mesh density for geometric actors", () => {
        expect(resolveDirectorActorShape("standard_male").footLength).toBeGreaterThan(0.1);
        expect(resolveDirectorActorShape("standard_male").radialSegments).toBeGreaterThan(resolveDirectorActorShape("geometric").radialSegments);
        expect(resolveDirectorActorShape("geometric").radialSegments).toBe(8);
    });
});
