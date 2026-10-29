export type VideoCropRect = { x: number; y: number; width: number; height: number };
export type VideoDimensions = { width: number; height: number };
export type VideoCropHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

const minimumCropSize = 16;

export function resizeVideoCrop(crop: VideoCropRect, video: VideoDimensions, handle: VideoCropHandle, deltaX: number, deltaY: number): VideoCropRect {
    const east = crop.x + crop.width;
    const south = crop.y + crop.height;
    let left = crop.x;
    let top = crop.y;
    let right = east;
    let bottom = south;

    if (handle.includes("w")) left = clamp(crop.x + deltaX, 0, east - minimumCropSize);
    if (handle.includes("e")) right = clamp(east + deltaX, crop.x + minimumCropSize, video.width);
    if (handle.includes("n")) top = clamp(crop.y + deltaY, 0, south - minimumCropSize);
    if (handle.includes("s")) bottom = clamp(south + deltaY, crop.y + minimumCropSize, video.height);

    return { x: Math.round(left), y: Math.round(top), width: Math.round(right - left), height: Math.round(bottom - top) };
}

export function moveVideoCrop(crop: VideoCropRect, video: VideoDimensions, deltaX: number, deltaY: number): VideoCropRect {
    return {
        ...crop,
        x: Math.round(clamp(crop.x + deltaX, 0, video.width - crop.width)),
        y: Math.round(clamp(crop.y + deltaY, 0, video.height - crop.height)),
    };
}

/**
 * H.264/yuv420p encoders require an even crop origin and output dimensions.
 * Keep the selection inside the actual source frame while preserving as much
 * of the user's selected area as possible.
 */
export function normalizeVideoCropForEncoding(crop: VideoCropRect, video: VideoDimensions): VideoCropRect {
    const sourceWidth = Math.max(2, Math.floor(video.width));
    const sourceHeight = Math.max(2, Math.floor(video.height));
    const x = clampEvenOrigin(crop.x, 0, sourceWidth - 2);
    const y = clampEvenOrigin(crop.y, 0, sourceHeight - 2);
    const width = clampEvenSize(crop.width, 2, sourceWidth - x);
    const height = clampEvenSize(crop.height, 2, sourceHeight - y);
    return { x, y, width, height };
}

function clampEvenOrigin(value: number, minimum: number, maximum: number) {
    const evenMinimum = Math.ceil(minimum / 2) * 2;
    const evenMaximum = Math.max(evenMinimum, Math.floor(maximum / 2) * 2);
    const rounded = Math.floor(value / 2) * 2;
    return clamp(rounded, evenMinimum, evenMaximum);
}

function clampEvenSize(value: number, minimum: number, maximum: number) {
    const evenMinimum = Math.ceil(minimum / 2) * 2;
    const evenMaximum = Math.max(evenMinimum, Math.floor(maximum / 2) * 2);
    const rounded = Math.round(value / 2) * 2;
    return clamp(rounded, evenMinimum, evenMaximum);
}

function clamp(value: number, minimum: number, maximum: number) {
    return Math.max(minimum, Math.min(maximum, value));
}
