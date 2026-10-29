import { describe, expect, test } from "bun:test";

import { resolveDirectorFocusFrame } from "../src/lib/canvas/director/director-focus";

describe("场景资产聚焦取景", () => {
    test("移动观察相机对准目标，并按主体半径与 FOV 取景", () => {
        const frame = resolveDirectorFocusFrame({
            cameraPosition: [0, 2, 8],
            cameraTarget: [0, 0, 0],
            focusTarget: [4, 1, -2],
            radius: 1,
            fov: 50,
        });

        expect(frame?.target).toEqual([4, 1, -2]);
        expect(frame?.position[1]).toBeGreaterThan(1);
        expect(frame?.position[2]).toBeGreaterThan(-2);
        expect(Math.hypot(frame!.position[0] - 4, frame!.position[1] - 1, frame!.position[2] + 2)).toBeGreaterThan(2);
    });

    test("无效目标不改相机，极端半径和 FOV 被限制", () => {
        expect(resolveDirectorFocusFrame({ cameraPosition: [0, 0, 4], cameraTarget: [0, 0, 0], focusTarget: [Number.NaN, 0, 0], radius: 1, fov: 50 })).toBeNull();
        const near = resolveDirectorFocusFrame({ cameraPosition: [0, 0, 4], cameraTarget: [0, 0, 0], focusTarget: [0, 0, 0], radius: 0.01, fov: 180 });
        const far = resolveDirectorFocusFrame({ cameraPosition: [0, 0, 4], cameraTarget: [0, 0, 0], focusTarget: [0, 0, 0], radius: 10000, fov: 1 });
        expect(Math.hypot(...near!.position)).toBeGreaterThanOrEqual(1.24);
        expect(Math.hypot(...far!.position)).toBeLessThanOrEqual(80);
    });
});
