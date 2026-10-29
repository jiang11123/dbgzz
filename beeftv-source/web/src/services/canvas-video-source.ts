import { resolveResourceVideoPlayback } from "@/services/resource-video-playback";

export type CanvasVideoSource = { url: string; release: () => void };

/** Use the original for browser-compatible files and the existing H.264 copy for HEVC. */
export async function acquireCanvasVideoSource(storageKey?: string, fallback = "", signal?: AbortSignal): Promise<CanvasVideoSource> {
    const requestSignal = signal || new AbortController().signal;
    const resolved = await resolveResourceVideoPlayback(storageKey || "", fallback, requestSignal);
    requestSignal.throwIfAborted();
    if (typeof resolved === "string") return { url: resolved, release: () => undefined };
    const url = URL.createObjectURL(resolved.blob);
    return { url, release: () => URL.revokeObjectURL(url) };
}
