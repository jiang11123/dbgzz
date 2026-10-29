/** Release borrowed playback state synchronously on abort, before another session takes over. */
export function restoreDirectorPlaybackOnEnd(signal: AbortSignal, restore: () => void) {
    let restored = false;
    const end = () => {
        if (restored) return;
        restored = true;
        signal.removeEventListener("abort", end);
        restore();
    };
    signal.addEventListener("abort", end, { once: true });
    if (signal.aborted) end();
    return end;
}

/** Wait for React/R3F to swap from the free camera before recording the canvas. */
export async function waitForDirectorCaptureCamera(
    readCamera: () => "free" | "camera" | "orthographic" | null,
    nextFrame: () => Promise<void> = () => new Promise((resolve) => requestAnimationFrame(() => resolve())),
    maxFrames = 60,
): Promise<void> {
    for (let frame = 0; frame < maxFrames; frame += 1) {
        if (readCamera() === "camera") {
            await nextFrame();
            if (readCamera() === "camera") return;
        } else {
            await nextFrame();
        }
    }
    throw new Error("当前场景没有可用机位，无法生成参考视频");
}
