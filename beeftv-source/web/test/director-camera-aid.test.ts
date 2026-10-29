import { describe, expect, test } from "bun:test";
import * as cameraAid from "../src/lib/canvas/director/director-camera-aid";

const { directorCameraFrameSegments, directorCameraGuideSegments } = cameraAid;

describe("导演台机位辅助框", () => {
    test("默认机位的辅助框靠近机位本体，避免在导演视角遮满人物和画布", () => {
        const distance = (cameraAid as typeof cameraAid & { directorCameraAidDistance?: (targetDistance: number) => number }).directorCameraAidDistance;
        expect(distance?.(10)).toBe(1);
        expect(distance?.(4)).toBe(0.6);
        expect(distance?.(30)).toBe(1.2);
    });

    test("只绘制取景矩形边缘，不画穿过画面的机位射线", () => {
        const corners: [number, number, number][] = [
            [-2, 1, -3], [2, 1, -3], [2, -1, -3], [-2, -1, -3],
        ];
        expect(directorCameraFrameSegments(corners)).toEqual([
            corners[0], corners[1],
            corners[1], corners[2],
            corners[2], corners[3],
            corners[3], corners[0],
        ]);
    });

    test("参考页机位框两侧向下延伸，但不画穿过人物的对角线", () => {
        const corners: [number, number, number][] = [
            [-2, 1, -3], [2, 1, -3], [2, -1, -3], [-2, -1, -3],
        ];
        expect(directorCameraGuideSegments(corners)).toEqual([
            [-2, -1, -3], [-1.86, -2.8, -3],
            [2, -1, -3], [1.86, -2.8, -3],
        ]);
    });

    test("活动机位即使未选中也保留可点击本体，靠近视角时仅隐藏遮挡画面的辅助框", () => {
        const visibility = (cameraAid as typeof cameraAid & { directorCameraAidVisibility?: (selected: boolean, nearViewer: boolean) => { body: boolean; guides: boolean; gizmo: boolean } }).directorCameraAidVisibility;
        expect(visibility?.(false, false)).toEqual({ body: true, guides: true, gizmo: false });
        expect(visibility?.(true, true)).toEqual({ body: true, guides: false, gizmo: true });
        expect(visibility?.(false, true)).toEqual({ body: false, guides: false, gizmo: false });
    });

    test("拖动手柄期间的画布空点不能清除机位选择，普通空点仍可取消选择", () => {
        const shouldClear = (cameraAid as typeof cameraAid & { shouldClearDirectorViewportSelection?: (drawing: boolean, transformClaimed: boolean) => boolean }).shouldClearDirectorViewportSelection;
        expect(shouldClear?.(false, true)).toBe(false);
        expect(shouldClear?.(false, false)).toBe(true);
        expect(shouldClear?.(true, false)).toBe(false);
    });
});
