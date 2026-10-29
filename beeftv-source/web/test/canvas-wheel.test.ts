import { expect, test } from "bun:test";
import { canvasWheelIntent } from "../src/lib/canvas/canvas-wheel";

const wheel = (deltaY: number, extra = {}) => ({ deltaY, deltaX: 0, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false, ...extra });
test("普通滚轮的 60/80/100/120 步长都缩放，包括行单位", () => {
    for (const delta of [60, 80, 100, 120, -120]) expect(canvasWheelIntent(wheel(delta), null, 0)).toBe("zoom");
    expect(canvasWheelIntent(wheel(3, { deltaMode: 1 }), null, 0)).toBe("zoom");
});
test("连续手势保持动作，触控板小幅滚动和水平滚动仍平移", () => {
    expect(canvasWheelIntent(wheel(3), null, 0)).toBe("pan");
    expect(canvasWheelIntent(wheel(100), { intent: "pan", at: 0 }, 50)).toBe("pan");
    expect(canvasWheelIntent(wheel(7), { intent: "zoom", at: 0 }, 50)).toBe("zoom");
    expect(canvasWheelIntent(wheel(120, { deltaX: 2 }), null, 0)).toBe("pan");
    expect(canvasWheelIntent(wheel(120, { shiftKey: true }), null, 0)).toBe("pan");
    expect(canvasWheelIntent(wheel(2, { ctrlKey: true }), { intent: "pan", at: 0 }, 50)).toBe("zoom");
    expect(canvasWheelIntent(wheel(120), { intent: "pan", at: 0 }, 250)).toBe("zoom");
});
