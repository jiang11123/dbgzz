import { describe, expect, test } from "bun:test";

import { DIRECTOR_ASPECT_RATIOS, isDirectorAspectRatio, resolveDirectorFrameRect, resolveDirectorPixelCrop } from "@/lib/canvas/director/director-aspect-ratio";

describe("导演台画幅取景与导出", () => {
    test("提供 LibTV 七个选项并拒绝损坏的持久化值", () => {
        expect(DIRECTOR_ASPECT_RATIOS).toEqual(["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]);
        expect(isDirectorAspectRatio("9:16")).toBe(true);
        expect(isDirectorAspectRatio("0:0")).toBe(false);
    });

    test("自适应使用完整视口；竖幅预览与像素裁切都居中且比例一致", () => {
        expect(resolveDirectorFrameRect(1200, 800, "adaptive")).toEqual({ x: 0, y: 0, width: 1200, height: 800 });
        const preview = resolveDirectorFrameRect(1200, 800, "9:16");
        const crop = resolveDirectorPixelCrop(1200, 800, "9:16");
        expect(preview.width / preview.height).toBeCloseTo(9 / 16);
        expect(crop.width / crop.height).toBeCloseTo(9 / 16, 2);
        expect(preview.x).toBeCloseTo((1200 - preview.width) / 2);
        expect(crop.y).toBeCloseTo((800 - crop.height) / 2, 0);
    });

    test("横幅和方幅均保持在视口内", () => {
        for (const ratio of ["21:9", "1:1", "3:4"] as const) {
            const frame = resolveDirectorFrameRect(900, 500, ratio);
            expect(frame.x).toBeGreaterThanOrEqual(0);
            expect(frame.y).toBeGreaterThanOrEqual(0);
            expect(frame.x + frame.width).toBeLessThanOrEqual(900);
            expect(frame.y + frame.height).toBeLessThanOrEqual(500);
        }
    });

    test("取景框与 LibTV 画布导演台的左右 48px、上下 112px 安全边距一致", () => {
        expect(resolveDirectorFrameRect(878, 747, "16:9")).toEqual({ x: 48, y: 153.5625, width: 782, height: 439.875 });
        expect(resolveDirectorFrameRect(878, 747, "1:1")).toEqual({ x: 177.5, y: 112, width: 523, height: 523 });
        expect(resolveDirectorFrameRect(878, 747, "9:16")).toEqual({ x: 291.90625, y: 112, width: 294.1875, height: 523 });
    });

    test("高分屏导出裁切与 CSS 取景框对齐，而不是再次扣固定物理像素", () => {
        expect(resolveDirectorPixelCrop(1756, 1494, "16:9", { width: 878, height: 747 })).toEqual({ x: 96, y: 307, width: 1564, height: 880 });
    });
});
