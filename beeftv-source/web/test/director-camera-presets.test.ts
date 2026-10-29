import { describe, expect, test } from "bun:test";

import { createDirectorCameraFromPreset, DIRECTOR_CAMERA_PRESETS } from "@/lib/canvas/director/director-camera-presets";
import { createDirectorScene } from "@/lib/canvas/director/director-scene";
import { resolveDirectorCameraLocalFraming } from "@/lib/canvas/director/director-view-modes";

describe("导演台机位预设", () => {
    test("面板提供 LibTV 的全部机位入口且名称不重复", () => {
        expect(DIRECTOR_CAMERA_PRESETS.map((item) => item.label)).toEqual([
            "当前视角", "正面中景", "正面特写", "正面全景", "侧面跟拍", "侧面近景", "背面中景", "俯拍全景",
            "45° 俯拍", "低角度仰拍", "低角度广角", "过肩镜头", "过肩镜头（右）", "鸟瞰", "荷兰角",
        ]);
    });

    test("预设写入不同的实际机位和光学参数", () => {
        const medium = createDirectorCameraFromPreset({ presetId: "front-medium", name: "测试", target: [1, 1, 2] });
        const close = createDirectorCameraFromPreset({ presetId: "front-close", name: "测试", target: [1, 1, 2] });
        expect(medium.transform.position).not.toEqual(close.transform.position);
        expect(medium.fov).not.toBe(close.fov);
        expect(medium.target).toEqual([1, 1, 2]);
        expect(close.target).toEqual([1, 1, 2]);
    });

    test("正反面与过肩机位随演员朝向一起旋转", () => {
        const target: [number, number, number] = [1, 1, 2];
        const front = createDirectorCameraFromPreset({ presetId: "front-medium", name: "正面", target });
        const back = createDirectorCameraFromPreset({ presetId: "back-medium", name: "背面", target });
        const shoulder = createDirectorCameraFromPreset({ presetId: "shoulder-left", name: "过肩", target });
        const rotatedFront = createDirectorCameraFromPreset({ presetId: "front-medium", name: "旋转后正面", target, subjectYaw: Math.PI / 2 });
        expect(front.transform.position[2]).toBeGreaterThan(target[2]);
        expect(back.transform.position[2]).toBeLessThan(target[2]);
        expect(shoulder.transform.position[2]).toBeLessThan(target[2]);
        expect(rotatedFront.transform.position[0]).toBeGreaterThan(target[0]);
        expect(rotatedFront.transform.position[2]).toBeCloseTo(target[2], 5);
    });

    test("当前视角记录当前位置与朝向；鸟瞰和荷兰角均可安全取景", () => {
        const current = createDirectorCameraFromPreset({ presetId: "current", name: "当前", target: [0, 1, 0], currentView: { position: [3, 2, 4], rotation: [0, 0, 0], scale: [1, 1, 1] } });
        expect(current.transform.position).toEqual([3, 2, 4]);
        expect(current.target).toEqual([3, 2, -1]);
        const birdEye = createDirectorCameraFromPreset({ presetId: "bird-eye", name: "鸟瞰", target: [0, 1, 0] });
        expect(birdEye.transform.position[1]).toBeGreaterThan(birdEye.target[1]);
        const dutch = createDirectorCameraFromPreset({ presetId: "dutch", name: "荷兰角", target: [0, 1, 0] });
        expect(dutch.transform.rotation[2]).not.toBe(0);
    });

    test("侧面跟拍预设绑定角色位置并持续注视角色", () => {
        const scene = createDirectorScene();
        const actor = scene.objects[0];
        const camera = createDirectorCameraFromPreset({
            presetId: "side-follow",
            name: "侧面跟拍",
            target: [actor.transform.position[0], actor.transform.position[1] + 1.2, actor.transform.position[2]],
            followTarget: { objectId: actor.id, position: actor.transform.position },
        });
        const movedScene = {
            ...scene,
            objects: scene.objects.map((item) => item.id === actor.id
                ? { ...item, transform: { ...item.transform, position: [actor.transform.position[0] + 3, actor.transform.position[1], actor.transform.position[2]] as [number, number, number] } }
                : item),
        };
        const before = resolveDirectorCameraLocalFraming(scene, camera, 0);
        const after = resolveDirectorCameraLocalFraming(movedScene, camera, 0);
        expect(camera.followObjectId).toBe(actor.id);
        expect(camera.lookAtMode).toBe("object");
        expect(camera.lookAtObjectId).toBe(actor.id);
        expect(after?.position[0]).toBeCloseTo((before?.position[0] || 0) + 3, 5);
        expect(after?.target[0]).toBeCloseTo((before?.target[0] || 0) + 3, 5);

        const staticFallback = createDirectorCameraFromPreset({ presetId: "side-follow", name: "侧面机位", target: [0, 1, 0] });
        expect(staticFallback.followObjectId).toBeUndefined();
        expect(staticFallback.lookAtObjectId).toBeUndefined();
    });
});
