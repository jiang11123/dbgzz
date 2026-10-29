import { expect, test } from "bun:test";
import { assertCanvasImageReferenceTable } from "../src/lib/canvas/canvas-reference-table";

test("only rejects an unambiguous explicit IMAGE table binding", () => {
    const images = [{ title: "甲", label: "图片1" }, { title: "乙", label: "图片2" }];
    for (const prompt of ["| IMAGE 1 | `@乙` |", "| IMAGE 1 | @图片2 |", "| image 1 | @乙 |"])
        expect(() => assertCanvasImageReferenceTable(prompt, images)).toThrow("IMAGE 1 对应图片2");
    for (const prompt of ["| IMAGE 2 | `@乙` |", "| IMAGE 1 | @图片1 |", "IMAGE 1 在画面左，2 个人", "| IMAGE 1 | 未绑定名称 |", "| IMAGE 1 | @unknown |"])
        expect(() => assertCanvasImageReferenceTable(prompt, images)).not.toThrow();
    expect(() => assertCanvasImageReferenceTable("| IMAGE 1 | @同名 |", [{ title: "同名", label: "图片1" }, { title: "同名", label: "图片2" }])).not.toThrow();
});

test("drawing labels resolve to their final image upload slot", () => {
    const images = [{ title: "草图", label: "绘图1" }, { title: "走廊", label: "图片1" }];
    expect(() => assertCanvasImageReferenceTable("| IMAGE 1 | @图片1 |", images)).toThrow("IMAGE 1 对应图片2");
    expect(() => assertCanvasImageReferenceTable("| IMAGE 2 | @图片1 |\n| IMAGE 1 | @绘图1 |", images)).not.toThrow();
    expect(() => assertCanvasImageReferenceTable("| IMAGE 2 | @绘图1 |", images)).toThrow("IMAGE 2 对应图片1");
});
