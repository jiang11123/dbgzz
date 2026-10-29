import { captureUserScope, assertUserScope } from "@/lib/user-scope-guard";
import { refreshResource, prepareResourcePlayback, getResourcePlayback, resourceIdFromStorageKey, type ResourcePlayback } from "@/services/api/resources";
import { resolveMediaUrl } from "@/services/file-storage";

export async function resolveResourceVideoPlayback(storageKey: string, fallback: string, signal: AbortSignal, needsCompatible = false): Promise<string | ResourcePlayback> {
    const expectedScope = captureUserScope();
    const id = resourceIdFromStorageKey(storageKey);
    if (id) {
        let resource = await refreshResource(id, { signal, expectedScope });
        if (needsCompatible && resource.playbackStatus !== "processing") {
            resource = await prepareResourcePlayback(id, { signal, expectedScope });
        }
        for (let attempt = 0; resource.playbackStatus === "processing"; attempt += 1) {
            if (attempt >= 120) throw new Error("视频预览仍在准备中，请稍后重新打开");
            await waitForPlaybackPoll(signal);
            resource = await refreshResource(id, { signal, expectedScope });
        }
        if (resource.playbackStatus === "ready") {
            const playback = await getResourcePlayback(storageKey, { signal, expectedScope });
            assertUserScope(expectedScope);
            if (!playback) throw new Error("视频预览不可用，请重试");
            return playback;
        }
        if (needsCompatible && resource.playbackStatus !== "ready") throw new Error("视频已导入，暂时无法准备预览，请重试。原文件仍可下载。");
    }
    const url = await resolveMediaUrl(storageKey, fallback);
    assertUserScope(expectedScope);
    if (signal.aborted) throw signal.reason;
    return url;
}

function waitForPlaybackPoll(signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal.aborted) { reject(signal.reason); return; }
        const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
        const abort = () => { cleanup(); reject(signal.reason); };
        const timer = setTimeout(() => { cleanup(); resolve(); }, 2500);
        signal.addEventListener("abort", abort, { once: true });
    });
}
