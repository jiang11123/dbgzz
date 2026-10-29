import { expect, test } from "bun:test";
import { moveVideoCrop, normalizeVideoCropForEncoding, resizeVideoCrop } from "@/lib/canvas/video-crop-geometry";

test("resizeVideoCrop expands only the east edge and clamps it to the video bounds", () => {
    expect(resizeVideoCrop({ x: 72, y: 128, width: 576, height: 1024 }, { width: 720, height: 1280 }, "e", 120, 0)).toEqual({ x: 72, y: 128, width: 648, height: 1024 });
    expect(resizeVideoCrop({ x: 72, y: 128, width: 576, height: 1024 }, { width: 720, height: 1280 }, "e", 600, 0)).toEqual({ x: 72, y: 128, width: 648, height: 1024 });
});

test("resizeVideoCrop moves the west edge without moving the east edge", () => {
    expect(resizeVideoCrop({ x: 72, y: 128, width: 576, height: 1024 }, { width: 720, height: 1280 }, "w", 120, 0)).toEqual({ x: 192, y: 128, width: 456, height: 1024 });
});

test("moveVideoCrop never lets the crop selection leave the original video bounds", () => {
    const video = { width: 1080, height: 1920 };
    const crop = { x: 108, y: 192, width: 864, height: 1536 };

    expect(moveVideoCrop(crop, video, -1000, -1000)).toEqual({ ...crop, x: 0, y: 0 });
    expect(moveVideoCrop(crop, video, 1000, 1000)).toEqual({ ...crop, x: 216, y: 384 });
});

test("normalizeVideoCropForEncoding keeps H.264 crop dimensions even and inside the source", () => {
    expect(normalizeVideoCropForEncoding({ x: 31, y: 19, width: 289, height: 161 }, { width: 320, height: 180 })).toEqual({ x: 30, y: 18, width: 290, height: 162 });
});
