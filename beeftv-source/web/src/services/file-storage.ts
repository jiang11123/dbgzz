import { nanoid } from "nanoid";

import { getActiveUserScope } from "@/lib/user-scope";
import { assertUserScope, captureUserScope, isUserScopeAbandonedError, type CapturedUserScope } from "@/lib/user-scope-guard";
import { captureVideoPoster, detectVideoAudioTrackFromBlob } from "@/lib/video-poster";
import { resourceFileUrl, resourceIdFromStorageKey, resourceStorageKey, ResourceUploadError, uploadResourceFile } from "@/services/api/resources";
import { apiBaseURL } from "@/services/api/request";
import { uploadImage, type UploadedImage } from "@/services/image-storage";
import { createChannelTransport } from "@/services/api/channel-transport";
import { useConfigStore } from "@/stores/use-config-store";
import { cacheResourceObjectUrl, getCachedResourceBlob, getCachedResourceObjectUrl, primeResourceBlobCache } from "@/services/resource-blob-cache";
import { cleanupLocalMedia, deleteLocalMedia, getLocalMediaBlob, resolveLocalMediaUrl, saveLocalMedia, setLocalMediaBlob } from "@/services/local-media-repository";
import { usesBrowserLocalResourceStore } from "@/services/workspace-resource-storage";
import { startOperation } from "@/stores/use-operation-progress";

export type UploadedFile = {
    url: string;
    storageKey: string;
    bytes: number;
    mimeType: string;
    width?: number;
    height?: number;
    durationMs?: number;
    hasAudio?: boolean;
    preview?: UploadedImage;
    /**
     * true 表示本地 Go 资源服务暂时不可用、文件当前只存在于本机 IndexedDB。
     * 在那之前 `url` 是页面级 objectURL，刷新后需要从本地缓存恢复。
     */
    pendingRemoteUpload?: boolean;
    /** 直传失败原因，仅在 pendingRemoteUpload 为 true 时有值。 */
    remoteUploadError?: string;
};

export async function uploadMediaFile(input: Blob, prefix = "file", onProgress?: (uploadedBytes: number, totalBytes: number) => void, expectedScope?: CapturedUserScope): Promise<UploadedFile> {
    // 直传和失败后的本地同步必须复用同一上传身份，避免响应丢失后创建第二个对象。
    const expected = expectedScope ?? captureUserScope();
    const storageKey = `${prefix}:${expected.userScope}:${nanoid()}`;
    const blob = input;
    const isVideo = prefix === "video" || blob.type.startsWith("video/");
    const previewUrl = URL.createObjectURL(blob);
    let retainPreviewUrl = false;

    try {
        let captured: Awaited<ReturnType<typeof captureVideoPoster>> | undefined;
        if (isVideo) {
            try {
                captured = await captureVideoPoster(previewUrl);
            } catch (error) {
                if (isUserScopeAbandonedError(error)) throw error;
                // 封面和轨道信息属于展示增强：失败不阻断原文件上传，但必须留下可诊断信号。
                console.warn("读取视频封面与媒体信息失败，继续上传原文件", { mimeType: blob.type, bytes: blob.size, error });
            }
        }
        assertUserScope(expected);

        // 浏览器轨道探测对部分 MP4/MOV 会误报；只有未确认存在音轨时才做二次解析，
        // 避免正常上传重复读取整个文件。
        let parsedHasAudio: boolean | undefined;
        if (isVideo && captured?.hasAudio !== true) {
            try {
                parsedHasAudio = await detectVideoAudioTrackFromBlob(blob);
            } catch (error) {
                if (isUserScopeAbandonedError(error)) throw error;
                console.warn("解析视频音轨失败，继续上传但不写入音轨结论", { mimeType: blob.type, bytes: blob.size, error });
            }
        }
        assertUserScope(expected);
        const resolvedHasAudio = parsedHasAudio ?? (captured?.hasAudio === false ? undefined : captured?.hasAudio);

        let meta: { width?: number; height?: number; durationMs?: number; hasAudio?: boolean };
        if (captured) {
            meta = { width: captured.poster ? captured.width : undefined, height: captured.poster ? captured.height : undefined, durationMs: captured.durationMs, hasAudio: resolvedHasAudio };
        } else if (blob.type.startsWith("audio/")) {
            try {
                meta = await readAudioMeta(previewUrl);
            } catch (error) {
                if (isUserScopeAbandonedError(error)) throw error;
                console.warn("读取音频时长失败，继续上传原文件", { mimeType: blob.type, bytes: blob.size, error });
                meta = {};
            }
        } else {
            meta = { hasAudio: resolvedHasAudio };
        }
        assertUserScope(expected);

        let poster: UploadedImage | undefined;
        if (captured?.poster) {
            try {
                poster = await uploadImage(captured.poster, undefined, expected);
            } catch (error) {
                if (isUserScopeAbandonedError(error)) throw error;
                // 预览图失败不应把已经可用的视频降级成本地文件；视频本体仍按强校验上传。
                console.warn("上传视频预览图失败，继续保存视频本体", { mimeType: blob.type, bytes: blob.size, error });
            }
        }
        assertUserScope(expected);

        if (usesBrowserLocalResourceStore()) {
            assertUserScope(expected);
            const progress = startOperation(input instanceof File ? input.name : "保存媒体文件", { owner: expected, totalBytes: blob.size, detail: "正在保存媒体文件到本机" });
            try { await saveLocalMedia(storageKey, blob, previewUrl); progress.done("媒体文件已保存到本机"); }
            catch (error) { progress.fail("媒体保存未完成，请检查本机存储空间"); throw error; }
            retainPreviewUrl = true;
            return { url: previewUrl, storageKey, bytes: blob.size, mimeType: blob.type || "application/octet-stream", ...meta, preview: poster };
        }

        let remoteUploadError = "";
        // The native desktop Go resource service is the canonical local store.
        // Browser local mode keeps IndexedDB as its offline/development store.
        try {
            const kind = isVideo ? "video" : prefix === "audio" || blob.type.startsWith("audio/") ? "audio" : "file";
            const resource = await uploadResourceFile(blob, kind, { ...meta, fileName: input instanceof File ? input.name : undefined, idempotencyKey: storageKey, expectedScope: expected }, onProgress);
            assertUserScope(expected);
            try {
                await primeResourceBlobCache(resourceStorageKey(resource.id), blob, expected);
            } catch (error) {
                if (isUserScopeAbandonedError(error)) throw error;
                // 缓存只影响后续读取性能，服务端资源已经成功落盘，不得把缓存失败误报为上传失败。
                console.warn("预热媒体缓存失败，服务端资源已保存", { resourceId: resource.id, error });
            }
            return {
                url: resource.publicUrl || resourceFileUrl(resource.id),
                storageKey: resourceStorageKey(resource.id),
                bytes: resource.size || blob.size,
                mimeType: resource.mimeType || blob.type || "application/octet-stream",
                width: resource.width || meta.width,
                height: resource.height || meta.height,
                durationMs: resource.durationMs || meta.durationMs,
                hasAudio: meta.hasAudio,
                preview: poster,
            };
        } catch (error) {
            if (isUserScopeAbandonedError(error)) throw error;
            // 与图片上传同一套判定：永久性失败必须当场暴露，不能混进“稍后自动同步”。
            if (error instanceof ResourceUploadError && error.permanent) throw error;
            remoteUploadError = error instanceof Error ? error.message : "媒体直传失败";
        }

        assertUserScope(expected);
        // 本地资源服务暂时不可用时退回浏览器本地缓存，保持当前编辑可用。
        await saveLocalMedia(storageKey, blob, previewUrl);
        retainPreviewUrl = true;
        return {
            url: previewUrl,
            storageKey,
            bytes: blob.size,
            mimeType: blob.type || "application/octet-stream",
            ...meta,
            preview: poster,
            pendingRemoteUpload: true,
            remoteUploadError,
        };
    } finally {
        // 只有本地降级结果需要把 objectURL 留给页面；成功上传和所有异常路径都及时释放。
        if (!retainPreviewUrl) URL.revokeObjectURL(previewUrl);
    }
}

export async function resolveMediaUrl(storageKey?: string, fallback = "") {
    // Older canvas snapshots stored resource paths without the `/api` prefix.
    // In desktop mode those paths are interpreted by Wails as asset-server
    // paths and return its plain-text 404 page. Normalize them before handing
    // the URL to a native media element.
    if (!storageKey) {
        const legacyResource = fallback.match(/^\/resources\/([^/?#]+)\/file(?:[?#].*)?$/u);
        if (legacyResource) {
            const suffix = fallback.slice(legacyResource[0].indexOf("/file") + "/file".length);
            return `${String(apiBaseURL).replace(/\/+$/u, "")}/resources/${encodeURIComponent(legacyResource[1])}/file${suffix}`;
        }
        return await materializeExternalMedia(fallback);
    }
    const resourceId = resourceIdFromStorageKey(storageKey);
    if (resourceId) {
        const cached = await getCachedResourceObjectUrl(storageKey).catch(() => "");
        // A native <video> cannot attach the desktop launch token. If the
        // resource is not already cached, eagerly fetch it through the
        // authenticated client and hand the player a Blob URL.
        if (cached) return cached;
        const hydrated = await cacheResourceObjectUrl(storageKey).catch(() => "");
        return hydrated || resourceFileUrl(resourceId);
    }
    return resolveLocalMediaUrl(storageKey, fallback);
}

// MCP-created generation nodes may contain a provider URL instead of a local
// resource key. Native media elements cannot attach the provider Bearer token,
// so materialize that URL once through the configured channel and play the
// resulting local/blob resource. This also makes old canvases self-healing.
const externalMediaInflight = new Map<string, Promise<string>>();
async function materializeExternalMedia(url: string) {
    if (!/^https?:\/\//i.test(url) || !/enterprise\.beefapi\.com/i.test(url)) return url;
    const existing = externalMediaInflight.get(url);
    if (existing) return existing;
    const pending = (async () => {
        const expected = captureUserScope();
        const config = useConfigStore.getState().config;
        const channel =
            config.channels.find((item) => {
                try {
                    return new URL(item.baseUrl).hostname === new URL(url).hostname;
                } catch {
                    return false;
                }
            }) || config.channels.find((item) => /beefapi/i.test(`${item.id} ${item.name} ${item.baseUrl}`));
        if (!channel) return url;
        const blob = await createChannelTransport(
            {
                baseUrl: channel.baseUrl,
                apiKey: channel.credentialRef ? "" : channel.apiKey,
                apiFormat: channel.apiFormat,
                headers: channel.headers,
                credentialRef: channel.credentialRef || (channel.id === "beefapi" ? "beefapi-enterprise" : undefined),
            },
            "video",
        ).getBlob(url);
        const key = `external-video:${expected.userScope}:${nanoid()}`;
        assertUserScope(expected);
        if (usesBrowserLocalResourceStore()) {
            const objectUrl = URL.createObjectURL(blob);
            await saveLocalMedia(key, blob, objectUrl);
            return objectUrl;
        }
        const resource = await uploadResourceFile(blob, "video", { fileName: "generated-video.mp4", idempotencyKey: key, expectedScope: expected });
        assertUserScope(expected);
        const storageKey = resourceStorageKey(resource.id);
        try {
            await primeResourceBlobCache(storageKey, blob, expected);
        } catch (error) {
            if (isUserScopeAbandonedError(error)) throw error;
        }
        return (await getCachedResourceObjectUrl(storageKey).catch(() => "")) || resourceFileUrl(resource.id);
    })();
    externalMediaInflight.set(url, pending);
    try {
        return await pending;
    } finally {
        externalMediaInflight.delete(url);
    }
}

export async function getMediaBlob(storageKey: string) {
    if (resourceIdFromStorageKey(storageKey)) return getCachedResourceBlob(storageKey);
    return getLocalMediaBlob(storageKey);
}

export async function setMediaBlob(storageKey: string, blob: Blob) {
    if (resourceIdFromStorageKey(storageKey)) return primeResourceBlobCache(storageKey, blob);
    return setLocalMediaBlob(storageKey, blob);
}

export async function deleteStoredMedia(keys: Iterable<string>) {
    await deleteLocalMedia(Array.from(keys).filter((key) => !resourceIdFromStorageKey(key)));
}

export async function cleanupUnusedMedia(usedData: unknown, scope = getActiveUserScope()) {
    const usedKeys = collectMediaStorageKeys(usedData);
    const currentScope = scope;
    await cleanupLocalMedia(usedKeys, currentScope);
}

export function collectMediaStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && (value.storageKey.includes(":") || resourceIdFromStorageKey(value.storageKey))) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectMediaStorageKeys(child, keys)) : collectMediaStorageKeys(item, keys)));
    return keys;
}

function readAudioMeta(url: string) {
    return new Promise<{ durationMs?: number }>((resolve) => {
        const audio = document.createElement("audio");
        const done = () => resolve({ durationMs: Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : undefined });
        audio.onloadedmetadata = done;
        audio.onerror = done;
        audio.src = url;
    });
}
