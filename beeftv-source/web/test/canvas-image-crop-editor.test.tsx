import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { CanvasImageCropEditor, moveImageCrop, resizeImageCrop } from "../src/components/canvas/canvas-node-crop-dialog";

describe("CanvasImageCropEditor", () => {
    test("keeps moved and resized selections inside the image", () => {
        const moved = moveImageCrop({ x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, 0.5, -0.5);
        expect(moved.x).toBeCloseTo(0.2);
        expect({ ...moved, x: 0.2 }).toEqual({ x: 0.2, y: 0, width: 0.8, height: 0.8 });
        expect(resizeImageCrop({ x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, -0.5, -0.5, "nw")).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    });

    test("renders the image crop controls inline inside the original node", () => {
        const html = renderToStaticMarkup(<CanvasImageCropEditor imageUrl="data:image/png;base64,AAAA" imageDimensions={{ width: 1200, height: 800 }} onCancel={() => {}} onConfirm={() => {}} />);

        expect(html).toContain('data-image-crop-inline="true"');
        expect(html).toContain('aria-label="图片裁切选区"');
        expect(html).toContain('aria-label="取消裁切"');
        expect(html).toContain('aria-label="确认裁切"');
        expect(html).toContain("960 × 640");
        expect(html).toContain("bg-white text-black");
        expect(html).not.toContain("ant-modal");
        expect(html).not.toContain("fixed inset-0");
    });
});
