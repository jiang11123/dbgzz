import { probeMediaDurationMs, probeMediaMetadata, type MediaMetadata } from "@/lib/media-metadata";
import { getActiveUserScope } from "@/lib/user-scope";
import { getMediaBlob } from "@/services/file-storage";
import { getResource, ownedResourceIdFromMediaRef, resourceStorageKey } from "@/services/api/resources";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

const pending = new Map<string, Promise<MediaMetadata | undefined>>();
const METADATA_TIMEOUT_MS = 12_000;

/** Resolve missing metadata only from local media or owned resources, never arbitrary upstream URLs. */
export async function resolveReferenceMediaDuration<T extends ReferenceAudio | ReferenceVideo>(media: T): Promise<T> {
    if (Number.isFinite(media.durationMs) && (media.durationMs || 0) > 0 && (!media.type.startsWith("video/") || ((media as ReferenceVideo).width && (media as ReferenceVideo).height))) return media;
    const resourceId = ownedResourceIdFromMediaRef(media.storageKey, media.url);
    const storageKey = resourceId ? resourceStorageKey(resourceId) : media.storageKey;
    const localUrl = /^(blob:|data:)/i.test(media.url) ? media.url : "";
    if (!storageKey && !localUrl) return media;
    const key = JSON.stringify([getActiveUserScope(), storageKey || localUrl, media.type]);
    let task = pending.get(key);
    if (!task) {
        task = readDuration(media, resourceId, storageKey, localUrl).finally(() => pending.delete(key));
        pending.set(key, task);
    }
    const metadata = await task;
    return metadata ? { ...media, ...Object.fromEntries(Object.entries(metadata).filter(([, value]) => Number.isFinite(value) && Number(value) > 0)) } : media;
}

async function readDuration(media: ReferenceAudio | ReferenceVideo, resourceId: string, storageKey: string | undefined, localUrl: string) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            (async () => {
                if (resourceId) {
                    try {
                        const resource = await getResource(resourceId, { params: { metadata: "ensure" }, signal: controller.signal, timeout: 10_000 });
                        if (Number.isFinite(resource.durationMs) && (resource.durationMs || 0) > 0 && (!media.type.startsWith("video/") || (resource.width && resource.height))) return { durationMs: resource.durationMs, width: resource.width, height: resource.height };
                    } catch {
                        // Runtimes without a usable native probe retain the bounded browser path.
                        if (controller.signal.aborted) return undefined;
                    }
                }
                if (controller.signal.aborted) return undefined;
                let blob = storageKey ? await getMediaBlob(storageKey) : null;
                if (!blob && localUrl && !controller.signal.aborted) {
                    const response = await fetch(localUrl, { signal: controller.signal, credentials: "omit" });
                    if (!response.ok) return undefined;
                    blob = await response.blob();
                }
                if (!blob || controller.signal.aborted) return undefined;
                const file = new File([blob], media.name, { type: /^audio\/|^video\//.test(blob.type) ? blob.type : media.type });
                return file.type.startsWith("video/") ? probeMediaMetadata(file) : { durationMs: await probeMediaDurationMs(file) };
            })(),
            new Promise<undefined>((resolve) => {
                timer = setTimeout(() => {
                    controller.abort();
                    resolve(undefined);
                }, METADATA_TIMEOUT_MS);
            }),
        ]);
    } catch {
        // Existing duration validation reports unknown metadata; transport errors must not invent a duration.
        return undefined;
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}
