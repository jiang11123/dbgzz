import { assertUserScope, captureUserScope, isUserScopeAbandonedError, UserScopeAbandonedError, waitForRetryDelay, type CapturedUserScope } from "@/lib/user-scope-guard";
import { isLocalRuntimeMode } from "@/lib/runtime-mode";
import { createClientId } from "@/lib/client-id";
import { http, apiBaseURL, ApiError, type HttpRequestConfig } from "@/services/api/request";
import { startOperation } from "@/stores/use-operation-progress";

export type RemoteResource = {
    id: string;
    userId: string;
    kind: "image" | "video" | "audio" | "file" | string;
    status: "pending" | "ready" | "failed" | "deleted" | string;
    provider: string;
    endpoint: string;
    bucket: string;
    objectKey: string;
    publicUrl: string;
    mimeType: string;
    size: number;
    width?: number;
    height?: number;
    durationMs?: number;
    etag?: string;
	playbackStatus?: string;
	playbackObjectKey?: string;
	playbackError?: string;
	error?: string;
    createdAt: string;
    updatedAt: string;
};

export type AccountFileStorageUsage = {
    usedBytes: number;
    totalBytes: number;
};

export async function prepareResourcePlayback(id: string, config?: HttpRequestConfig) {
    const data = await http.post<{ resource: RemoteResource }>(`/resources/${encodeURIComponent(id)}/playback`, {}, config);
    return data.resource;
}

export async function clearVideoPreviewCache(config?: HttpRequestConfig) {
    const expectedScope = config?.expectedScope ?? captureUserScope();
    const result = await http.delete<{ cleared: number }>("/resources/playback-cache", { ...config, expectedScope });
    assertUserScope(expectedScope);
    return result;
}

export type ArkPrivateAssetSync = {
    resourceId: string;
    status: "active" | string;
};

export type ResourceUploadMeta = {
    width?: number;
    height?: number;
    durationMs?: number;
    fileName?: string;
    idempotencyKey?: string;
    expectedScope?: CapturedUserScope;
};

/**
 * 资源直传失败。
 *
 * `permanent` 是这条边界上唯一重要的信息：媒体直传失败后，调用方默认会把文件留在本机
 * IndexedDB；后端暂时不可用时由本地工作区继续保留素材。
 * 但鉴权失效、越权、请求本身不合法这几类失败重传多少次都是同样结果，把它们也归入
 * "稍后自动同步" 等于向用户撒谎，必须当场抛出。
 */
export class ResourceUploadError extends Error {
    readonly status?: number;
    /** true 表示重试不会自愈，调用方不得降级为本地暂存。 */
    readonly permanent: boolean;

    constructor(message: string, options: { status?: number; permanent: boolean; cause?: unknown }) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause });
        this.name = "ResourceUploadError";
        this.status = options.status;
        this.permanent = options.permanent;
    }
}

const resourceCache = new Map<string, RemoteResource>();
const resourceRequests = new Map<string, Promise<RemoteResource>>();
const missingResourceIds = new Set<string>();

export function resourceStorageKey(id: string) {
    return `resource:${id}`;
}

export async function getAccountFileStorageUsage() {
    const data = await http.get<{ usage: AccountFileStorageUsage }>("/resources/storage-usage");
    return data.usage;
}

export async function syncResourceToArkPrivateAsset(id: string) {
    const data = await http.post<{ sync: ArkPrivateAssetSync }>(`/resources/${encodeURIComponent(id)}/ark-private-asset`);
    return data.sync;
}

export function resourceIdFromStorageKey(storageKey?: string) {
    return storageKey?.startsWith("resource:") ? storageKey.slice("resource:".length) : "";
}

export function isResourceUrl(url?: string) {
    const base = String(apiBaseURL).replace(/\/+$/, "");
    const path = url?.split(/[?#]/, 1)[0] || "";
    return path.startsWith(`${base}/resources/`) && path.endsWith("/file");
}

const RESOURCE_FILE_PATH = /\/(?:api\/)?resources\/([^/]+)\/file$/;

export function ownedResourceIdFromMediaRef(storageKey?: string, url?: string) {
    const fromKey = resourceIdFromStorageKey(storageKey);
    if (fromKey) return fromKey;
    if (!url?.trim()) return "";
    if (isResourceUrl(url)) return resourceIdFromResourceFilePath(url.split(/[?#]/, 1)[0] || "");
    return resourceIdFromTrustedLocalFileUrl(url);
}

function resourceIdFromResourceFilePath(path: string) {
    const match = path.match(RESOURCE_FILE_PATH);
    if (!match) return "";
    try {
        return decodeURIComponent(match[1]);
    } catch {
        return "";
    }
}

function resourceIdFromTrustedLocalFileUrl(url: string) {
    try {
        const parsed = new URL(url, "http://127.0.0.1");
        if (parsed.protocol === "wails:") return resourceIdFromResourceFilePath(parsed.pathname);
        if ((parsed.protocol === "http:" || parsed.protocol === "https:") && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost")) {
            return resourceIdFromResourceFilePath(parsed.pathname);
        }
        if (url.startsWith("/")) return resourceIdFromResourceFilePath(parsed.pathname);
        return "";
    } catch {
        return "";
    }
}

// 超过该阈值（与后端单请求 multipart 上限 50MB 一致）的本地媒体走分片上传，避免大视频导入失败。
const CHUNK_UPLOAD_THRESHOLD = 50 << 20;
const CHUNK_UPLOAD_RETRIES = 2;

export async function uploadResourceFile(
    file: Blob,
    kind: "image" | "video" | "audio" | "file",
    meta?: ResourceUploadMeta,
    onProgress?: (uploadedBytes: number, totalBytes: number) => void,
): Promise<RemoteResource> {
    const expected = meta?.expectedScope ?? captureUserScope();
    const name = meta?.fileName || (file instanceof File ? file.name : `${kind}.${extensionFromMime(file.type, kind)}`);
    const progress = startOperation(name, { owner: expected, totalBytes: file.size, detail: isLocalRuntimeMode() ? "正在保存到本地资源目录" : "正在准备上传" });
    const report = (loaded: number, total: number) => { progress.progress(loaded, total); onProgress?.(loaded, total); };
    // 分片与 multipart 两条路径的失败都要归一成 ResourceUploadError，
    // 否则调用方只能靠文案猜测该重试还是该报错。
    try {
        if (file.size > CHUNK_UPLOAD_THRESHOLD) {
            const resource = await uploadFileInChunks(file, name, kind, meta, expected, report);
            rememberResource(resource, expected);
            progress.done("文件已确认并保存");
            return resource;
        }
        const formData = new FormData();
        formData.append("kind", kind);
        formData.append("file", file, name);
        if (meta?.width) formData.append("width", String(Math.round(meta.width)));
        if (meta?.height) formData.append("height", String(Math.round(meta.height)));
        if (meta?.durationMs) formData.append("durationMs", String(Math.round(meta.durationMs)));
        const data = await http.post<{ resource: RemoteResource }>("/resources", formData, {
            ...scopedUploadConfig(expected, meta?.idempotencyKey),
            onUploadProgress: ({ loaded, total }) => {
                if (total && total > 0) report(Math.min(file.size, file.size * loaded / total), file.size);
                else progress.progress(loaded);
            },
        });
        rememberResource(data.resource, expected);
        progress.done("文件已确认并保存");
        return data.resource;
    } catch (error) {
        if (isUserScopeAbandonedError(error)) progress.dismiss();
        else progress.fail("文件保存未完成，请查看上传提示后重试");
        throw normalizeUploadError(error);
    }
}

// 分片上传：POST 开始会话 → 逐片 PUT 原始二进制（每片 8MB）→ POST 合并落库。
// 同一次上传重试复用会话，只重传尚未确认完整收到的片。
async function uploadFileInChunks(file: Blob, name: string, kind: "image" | "video" | "audio" | "file", meta: ResourceUploadMeta | undefined, expected: CapturedUserScope, onProgress?: (uploadedBytes: number, totalBytes: number) => void) {
    const retryMeta = { ...meta, idempotencyKey: meta?.idempotencyKey || `resource-upload:${createClientId()}` };
    for (let attempt = 0; attempt < CHUNK_UPLOAD_RETRIES; attempt++) {
        try {
            return await runChunkedUpload(file, name, kind, retryMeta, expected, onProgress);
        } catch (error) {
            if (error instanceof ResourceUploadError && error.permanent) throw error;
            if (attempt === CHUNK_UPLOAD_RETRIES - 1) throw error;
            await prepareChunkRetry(error, expected);
        }
    }
    throw new Error("上传失败");
}

async function runChunkedUpload(file: Blob, name: string, kind: "image" | "video" | "audio" | "file", meta: ResourceUploadMeta | undefined, expected: CapturedUserScope, onProgress?: (uploadedBytes: number, totalBytes: number) => void) {
    const session = await http.post<{ uploadId: string; chunkSize: number; chunkCount: number; received?: number[] }>("/resources/uploads", { fileName: name, kind, size: file.size, width: meta?.width, height: meta?.height, durationMs: meta?.durationMs }, scopedUploadConfig(expected, meta?.idempotencyKey));
    const received = new Set(session.received ?? []);
    if (!session.uploadId || !Number.isSafeInteger(session.chunkSize) || session.chunkSize <= 0 || session.chunkCount !== Math.ceil(file.size / session.chunkSize) || [...received].some((index) => !Number.isInteger(index) || index < 0 || index >= session.chunkCount)) {
        throw new ResourceUploadError("上传分片回执无效", { permanent: true });
    }
    let uploaded = [...received].reduce((total, index) => total + Math.min(session.chunkSize, file.size - index * session.chunkSize), 0);
    if (uploaded > 0) onProgress?.(uploaded, file.size);
    for (let index = 0; index < session.chunkCount; index++) {
        assertUserScope(expected);
        if (received.has(index)) continue;
        const start = index * session.chunkSize;
        const end = Math.min(file.size, start + session.chunkSize);
        const blob = file.slice(start, end);
        // raw 二进制直传，与后端按裸 body 逐片落盘对齐（勿设手动 Content-Type，让 axios 处理）。
        await http.put<{ index: number }>(`/resources/uploads/${encodeURIComponent(session.uploadId)}/chunks/${index}`, blob, {
            headers: { "Content-Type": "application/octet-stream" },
            expectedScope: expected,
            onUploadProgress: onProgress ? ({ loaded }) => onProgress(uploaded + Math.min(loaded, blob.size), file.size) : undefined,
        });
        uploaded += blob.size;
        onProgress?.(uploaded, file.size);
    }
    assertUserScope(expected);
    const complete = await http.post<{ resource: RemoteResource }>(`/resources/uploads/${encodeURIComponent(session.uploadId)}/complete`, undefined, scopedUploadConfig(expected));
    return complete.resource;
}

async function prepareChunkRetry(error: unknown, expected: CapturedUserScope) {
    if (isUserScopeAbandonedError(error)) throw error;
    assertUserScope(expected);
    if (error instanceof ApiError && error.retryable && error.retryAfterMs) {
        await waitForRetryDelay(error.retryAfterMs);
        assertUserScope(expected);
    }
}

function rememberResource(resource: RemoteResource, expected: CapturedUserScope) {
    assertUserScope(expected);
    resourceCache.set(resourceCacheKey(resource.id, expected), resource);
}

// 失败分类直接复用 request() 已经算好的 ApiError.retryable（408/425/429/5xx 可重试），
// 不在这里另起一套响应码判断，避免两处规则漂移。
// 差别只有一处：没有拿到任何 HTTP 响应（断网、超时）时 retryable 为 false，
// 但这种失败恰恰是最该退回本机等待重传的，因此单独按瞬时处理。
function normalizeUploadError(error: unknown): ResourceUploadError {
    if (isUserScopeAbandonedError(error)) throw error;
    if (error instanceof ResourceUploadError) return error;
    // 请求取消不是上传失败，保持原始语义交给调用方。
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    if (error instanceof ApiError) {
        const status = error.status;
        const permanent = status !== undefined && !error.retryable;
        // 即使误超 50MB multipart 上限（后端 http.MaxBytesError），也给出可读中文而非英文裸错。
        if (status === 400 && /body too large|MaxBytes/i.test(error.message)) {
            return new ResourceUploadError("文件过大，请使用小于 50MB 的文件或稍后重试", { status, permanent: true, cause: error });
        }
        if (status === 413) return new ResourceUploadError("文件过大，无法上传", { status, permanent: true, cause: error });
        return new ResourceUploadError(error.message || "上传失败", { status, permanent, cause: error });
    }
    return new ResourceUploadError(error instanceof Error ? error.message : "上传失败", { permanent: false, cause: error });
}

export async function importResourceFromUrl(url: string, kind: "image" | "video" | "audio" | "file", meta?: Omit<ResourceUploadMeta, "fileName">) {
    const expected = meta?.expectedScope ?? captureUserScope();
    const data = await http.post<{ resource: RemoteResource }>("/resources/import", { url, kind, width: meta?.width, height: meta?.height, durationMs: meta?.durationMs }, scopedUploadConfig(expected, meta?.idempotencyKey));
    rememberResource(data.resource, expected);
    return data.resource;
}

function scopedUploadConfig(expected: CapturedUserScope, idempotencyKey?: string): HttpRequestConfig {
    const value = idempotencyKey?.trim();
    return value ? { headers: { "X-Idempotency-Key": value }, expectedScope: expected } : { expectedScope: expected };
}

function lookupAccessError(expected: CapturedUserScope, signal?: { aborted?: boolean }) {
    if (signal?.aborted) return new DOMException("Aborted", "AbortError");
    try {
        assertUserScope(expected);
        return undefined;
    } catch (error) {
        return error instanceof Error ? error : new UserScopeAbandonedError();
    }
}

function rememberLookupResult(cacheKey: string, resource: RemoteResource, expected: CapturedUserScope, signal?: { aborted?: boolean }) {
    const blocked = lookupAccessError(expected, signal);
    if (blocked) throw blocked;
    resourceCache.set(cacheKey, resource);
    missingResourceIds.delete(cacheKey);
    return resource;
}

export function getResource(id: string, config?: HttpRequestConfig): Promise<RemoteResource> {
    const expected = config?.expectedScope ?? captureUserScope();
    const blocked = lookupAccessError(expected, config?.signal);
    if (blocked) return Promise.reject(blocked);
    const cacheKey = resourceCacheKey(id, expected);
    const cached = resourceCache.get(cacheKey);
    const ensureMetadata = config?.params?.metadata === "ensure";
    if (cached && !ensureMetadata) return Promise.resolve(cached);
    if (missingResourceIds.has(cacheKey)) return Promise.reject(new Error("资源不存在或已被删除"));
    const sharePending = !config?.signal && !ensureMetadata;
    if (sharePending) {
        const pending = resourceRequests.get(cacheKey);
        if (pending) return pending;
    }
    const task = http.get<{ resource: RemoteResource }>(`/resources/${encodeURIComponent(id)}`, {
        ...config,
        signal: config?.signal,
        expectedScope: expected,
    })
        .then((data) => rememberLookupResult(cacheKey, data.resource, expected, config?.signal))
        .catch((error) => {
            if (isUserScopeAbandonedError(error)) throw error;
            if (error instanceof DOMException && error.name === "AbortError") throw error;
            const abandoned = lookupAccessError(expected, config?.signal);
            if (abandoned) throw abandoned;
            if (error instanceof ApiError && error.status === 404) missingResourceIds.add(cacheKey);
            throw error;
        })
        .finally(() => {
            if (sharePending && resourceRequests.get(cacheKey) === task) resourceRequests.delete(cacheKey);
        });
    if (sharePending) resourceRequests.set(cacheKey, task);
    return task;
}

// refreshResource 绕过缓存强制拉取资源最新状态（转码副本就绪轮询用），并回写缓存。
export function refreshResource(id: string, config?: HttpRequestConfig): Promise<RemoteResource> {
    const expected = config?.expectedScope ?? captureUserScope();
    const blocked = lookupAccessError(expected, config?.signal);
    if (blocked) return Promise.reject(blocked);
    const cacheKey = resourceCacheKey(id, expected);
    return http.get<{ resource: RemoteResource }>(`/resources/${encodeURIComponent(id)}`, {
        ...config,
        signal: config?.signal,
        expectedScope: expected,
    }).then((data) => rememberLookupResult(cacheKey, data.resource, expected, config?.signal));
}

export async function getResourceOSSUrl(storageKey?: string) {
    if (isLocalRuntimeMode()) {
        throw new Error("本地素材不会上传到对象存储；当前视频渠道要求公网 URL，请改用支持本地素材的渠道或直接提供公网素材地址");
    }
    const id = resourceIdFromStorageKey(storageKey);
    if (!id) throw new Error("当前媒体尚未上传到后端资源存储");
    try {
        const data = await http.get<{ url: string }>(`/resources/${encodeURIComponent(id)}/oss-url`);
        if (!data.url) throw new Error("后端未返回对象存储地址");
        return data.url;
    } catch (error) {
        if (error instanceof ApiError) throw new Error(error.message || "获取对象存储地址失败");
        throw error;
    }
}

function resourceCacheKey(id: string, expected: CapturedUserScope) {
    return `${expected.userScope}:${expected.epoch}:${id}`;
}

export function resourceFileUrl(id: string) {
    const base = String(apiBaseURL).replace(/\/+$/, "");
    return `${base}/resources/${encodeURIComponent(id)}/file`;
}

function resourceProxyFileUrl(id: string) {
    const base = String(apiBaseURL).replace(/\/+$/, "");
    return `${base}/resources/${encodeURIComponent(id)}/file?proxy=1`;
}

export function resolveResourceUrl(storageKey?: string, fallback = "") {
    const id = resourceIdFromStorageKey(storageKey);
    // 资源引用本身已经包含稳定 ID；恢复/展示阶段不需要再查一遍元数据。
    // 需要 publicUrl、mime 或尺寸时必须显式调用 getResource，避免隐式 N+1。
    return id ? resourceFileUrl(id) : fallback;
}

// playbackVariantUrl 返回浏览器兼容播放副本 URL（H.265→H.264 转码结果）。
// 副本就绪前由后端回退原件，调用方再按需降级。
export function playbackVariantUrl(id: string) {
    const base = String(apiBaseURL).replace(/\/+$/, "");
    return `${base}/resources/${encodeURIComponent(id)}/file?variant=playback`;
}

/**
 * Load a browser-compatible video through the authenticated API client. Native
 * media elements cannot attach the desktop launch token, and large videos must
 * not inherit the API client's short JSON-request timeout.
 */
export type ResourcePlayback = { blob: Blob; compatible: boolean };

export async function getResourcePlayback(storageKey: string, config?: HttpRequestConfig): Promise<ResourcePlayback | null> {
    const id = resourceIdFromStorageKey(storageKey);
    if (!id) return null;
    const response = await http.raw<Blob>({
        ...config,
        method: "get",
        url: `/resources/${encodeURIComponent(id)}/file?variant=playback&proxy=1`,
        expectedScope: config?.expectedScope ?? captureUserScope(),
        responseType: "blob",
        timeout: 0,
    });
    return {
        blob: response.data instanceof Blob ? response.data : new Blob([response.data]),
        // A ready database row may outlive its copy. The file endpoint then
        // serves the original with its original ETag; it must remain eligible
        // for decoder-error recovery.
        compatible: String(response.headers.etag || "").endsWith(':pb"'),
    };
}

export async function getResourcePlaybackBlob(storageKey: string, config?: HttpRequestConfig) {
    return (await getResourcePlayback(storageKey, config))?.blob ?? null;
}

export async function getResourceBlob(storageKey: string, config?: HttpRequestConfig) {
    const id = resourceIdFromStorageKey(storageKey);
    if (!id) return null;
    // Do not use a bare fetch here. Desktop mode protects resource routes with
    // X-Desktop-Token, which is attached by the shared axios client. A native
    // <video> element cannot add that header itself, so materialized media must
    // first be downloaded through this authenticated path and exposed as a
    // local object URL by resource-blob-cache.
    try {
        const response = await http.raw<Blob>({
            ...config,
            method: "get",
            url: `/resources/${encodeURIComponent(id)}/file?proxy=1`,
            expectedScope: config?.expectedScope ?? captureUserScope(),
            responseType: "blob",
            // Images may be much larger than JSON responses; keep the shared
            // authenticated media path independent of the 4 s JSON timeout.
            timeout: 0,
        });
        return response.data instanceof Blob ? response.data : new Blob([response.data]);
    } catch (error) {
        if (isUserScopeAbandonedError(error) || (error instanceof DOMException && error.name === "AbortError")) throw error;
        return null;
    }
}

function extensionFromMime(mimeType: string, kind: string) {
    if (mimeType.includes("png")) return "png";
    if (mimeType.includes("jpeg")) return "jpg";
    if (mimeType.includes("webp")) return "webp";
    if (mimeType.includes("gif")) return "gif";
    if (mimeType.includes("mp4")) return "mp4";
    if (mimeType.includes("webm")) return "webm";
    if (mimeType.includes("mpeg")) return "mp3";
    if (mimeType.includes("wav")) return "wav";
    return kind === "image" ? "png" : "bin";
}
