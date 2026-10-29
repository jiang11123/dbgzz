import { describe, expect, test } from "bun:test";

import { createDirectorScene } from "@/lib/canvas/director/director-scene";
import { directorStageLocalCamera, directorStageLocalPoint, directorStagePoint, directorStageTransform, type DirectorStageTransform } from "@/lib/canvas/director/director-stage-transform";
import { resolveDirectorOrthographicFraming, resolveDirectorViewFraming } from "@/lib/canvas/director/director-view-modes";

const stage: DirectorStageTransform = { scale: 2, position: [3, 1, -4], rotation: [0, 90, 0] };

describe("导演台场景整体变换", () => {
    test("旧存档没有新字段时保持原始坐标", () => {
        const scene = createDirectorScene();
        delete scene.stageTransform;
        expect(directorStageTransform(scene).scale).toBe(1);
        expect(directorStagePoint(directorStageTransform(scene), [1, 2, 3])).toEqual([1, 2, 3]);
    });

    test("损坏的缩放和轴值回退到单位变换，不污染 WebGL 矩阵", () => {
        const scene = createDirectorScene();
        scene.stageTransform = { scale: 0, position: [0, 0, 0], rotation: [0, 0, 0] };
        expect(directorStageTransform(scene).scale).toBe(1);
        scene.stageTransform = { scale: 2, position: [Number.NaN, 0, 0], rotation: [0, 0, 0] };
        expect(directorStageTransform(scene).position).toEqual([0, 0, 0]);
    });

    test("点在场景/世界坐标之间可逆，指针放置不会随缩放旋转错位", () => {
        const local: [number, number, number] = [1.5, 0, -2];
        const world = directorStagePoint(stage, local);
        const restored = directorStageLocalPoint(stage, world);
        restored.forEach((value, index) => expect(value).toBeCloseTo(local[index], 5));
    });

    test("CAM 摄影机与对象共用变换，焦距和裁剪距离随比例同步", () => {
        const scene = createDirectorScene();
        scene.stageTransform = stage;
        const framing = resolveDirectorViewFraming({ scene, mode: "camera", playhead: 0 });
        expect(framing?.position).toEqual(directorStagePoint(stage, scene.cameras[0].transform.position));
        expect(framing?.target).toEqual(directorStagePoint(stage, scene.cameras[0].target));
        expect(framing?.near).toBeCloseTo(scene.cameras[0].near * 2);
        expect(framing?.far).toBeCloseTo(scene.cameras[0].far * 2);
    });

    test("世界视图对齐回写时恢复为场景局部机位", () => {
        const local = { position: [1, 2, 3] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] };
        const world = { ...local, position: directorStagePoint(stage, local.position), rotation: [0, Math.PI / 2, 0] as [number, number, number] };
        const restored = directorStageLocalCamera(stage, world);
        restored.position.forEach((value, index) => expect(value).toBeCloseTo(local.position[index], 5));
        restored.rotation.forEach((value) => expect(value).toBeCloseTo(0, 5));
    });

    test("正交包围盒随场景平移", () => {
        const scene = createDirectorScene();
        const original = resolveDirectorOrthographicFraming({ scene, mode: "front" });
        scene.stageTransform = { scale: 1, position: [10, 0, 0], rotation: [0, 0, 0] };
        const moved = resolveDirectorOrthographicFraming({ scene, mode: "front" });
        expect(moved?.target[0]).toBeCloseTo((original?.target[0] ?? 0) + 10);
        expect(moved?.horizontalSpan).toBeCloseTo(original?.horizontalSpan ?? 0);
    });
});
