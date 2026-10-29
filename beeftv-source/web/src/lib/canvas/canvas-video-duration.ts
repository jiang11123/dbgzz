export function resolveCanvasVideoDurationMs(metadataDurationMs: number | undefined, elementDurationSeconds: number | undefined) {
    const metadataDuration = Number(metadataDurationMs);
    if (Number.isFinite(metadataDuration) && metadataDuration > 0) return Math.round(metadataDuration);

    const elementDuration = Number(elementDurationSeconds);
    if (!Number.isFinite(elementDuration) || elementDuration <= 0) return 0;
    return Math.round(elementDuration * 1000);
}
