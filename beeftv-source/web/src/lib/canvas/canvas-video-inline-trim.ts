import type { CanvasNodeMetadata } from "@/types/canvas";

export type InlineVideoTrimRange = { startMs: number; endMs: number };

export const INLINE_VIDEO_TRIM_MIN_MS = 100;

export function placeInlineVideoTrimDuration(timelineWidth: number, startPercent: number, endPercent: number, labelWidth: number) {
    if (timelineWidth <= 0 || labelWidth <= 0) return { floating: false, left: 0 };
    const selectionWidth = ((endPercent - startPercent) / 100) * timelineWidth;
    const floating = selectionWidth < labelWidth + 64; // Two 28px handles plus breathing room.
    const selectionCenter = ((startPercent + endPercent) / 200) * timelineWidth;
    const edgeInset = labelWidth / 2 + 4;
    return { floating, left: Math.max(edgeInset, Math.min(timelineWidth - edgeInset, selectionCenter)) };
}

export function normalizeInlineVideoTrimRange(range: InlineVideoTrimRange, durationMs: number): InlineVideoTrimRange {
    const duration = Math.max(INLINE_VIDEO_TRIM_MIN_MS, Math.round(durationMs));
    let startMs = Math.min(duration, Math.max(0, Math.round(range.startMs)));
    let endMs = Math.min(duration, Math.max(0, Math.round(range.endMs)));
    if (endMs < startMs) [startMs, endMs] = [endMs, startMs];
    if (endMs - startMs >= INLINE_VIDEO_TRIM_MIN_MS) return { startMs, endMs };
    if (startMs + INLINE_VIDEO_TRIM_MIN_MS <= duration) endMs = startMs + INLINE_VIDEO_TRIM_MIN_MS;
    else startMs = Math.max(0, duration - INLINE_VIDEO_TRIM_MIN_MS);
    return { startMs, endMs: Math.min(duration, Math.max(endMs, startMs + INLINE_VIDEO_TRIM_MIN_MS)) };
}

export function moveInlineVideoTrimRange(range: InlineVideoTrimRange, deltaMs: number, durationMs: number): InlineVideoTrimRange {
    const normalized = normalizeInlineVideoTrimRange(range, durationMs);
    const selectedDuration = normalized.endMs - normalized.startMs;
    const desiredStart = normalized.startMs + Math.round(deltaMs);
    const startMs = Math.min(Math.max(0, Math.round(durationMs) - selectedDuration), Math.max(0, desiredStart));
    return { startMs, endMs: startMs + selectedDuration };
}

export function applyInlineVideoTrimMetadata(
    previous: CanvasNodeMetadata,
    media: CanvasNodeMetadata,
    range: InlineVideoTrimRange,
): CanvasNodeMetadata {
    const source = previous.videoTrimSource || {
        content: previous.content,
        storageKey: previous.storageKey,
        durationMs: previous.durationMs,
        naturalWidth: previous.naturalWidth,
        naturalHeight: previous.naturalHeight,
        bytes: previous.bytes,
        mimeType: previous.mimeType,
        hasAudio: previous.hasAudio,
    };
    return {
        ...previous,
        ...media,
        assetId: undefined,
        mediaOperationError: undefined,
        videoTrimSource: source,
        videoTrimStartMs: range.startMs,
        videoTrimEndMs: range.endMs,
    };
}
