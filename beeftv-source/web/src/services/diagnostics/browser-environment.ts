import type { EnvironmentCheck } from "./environment-check";
import { captureUserScopeEpoch, subscribeUserScope, userScopeEpochMatches } from "@/lib/user-scope";

let storageWritable: boolean | undefined;
let storageTimedOut = false;
let latestStorageProbe = 0;
subscribeUserScope(() => {
    latestStorageProbe++;
    storageWritable = undefined;
    storageTimedOut = false;
});

export type BrowserCapabilities = { secureRandom: boolean; randomUUID: boolean; structuredClone: boolean; indexedDB: boolean; storageWritable?: boolean; storageTimedOut?: boolean; webGL: boolean; h264: boolean; hevc: boolean };

export function browserCapabilities(): BrowserCapabilities {
    // Creating a GPU context can destabilize remote/virtual-display drivers.
    // Presence is only an interface check, never proof of working acceleration.
    const webGL = typeof globalThis.WebGLRenderingContext !== "undefined";
    const video = typeof document === "undefined" ? undefined : document.createElement("video");
    let indexedDBAvailable = false;
    try { indexedDBAvailable = typeof globalThis.indexedDB !== "undefined"; } catch { /* Access can be denied for opaque origins. */ }
    return {
        secureRandom: typeof globalThis.crypto?.getRandomValues === "function",
        randomUUID: typeof globalThis.crypto?.randomUUID === "function",
        structuredClone: typeof globalThis.structuredClone === "function",
        indexedDB: indexedDBAvailable,
        storageWritable,
        storageTimedOut,
        webGL,
        h264: Boolean(video?.canPlayType('video/mp4; codecs="avc1.42E01E"')),
        hevc: Boolean(video?.canPlayType('video/mp4; codecs="hvc1"')),
    };
}

export function browserChecks(capabilities = browserCapabilities()): EnvironmentCheck[] {
    const check = (id: string, title: string, status: EnvironmentCheck["status"], detail: string, cases = ["ENV-0001"]): EnvironmentCheck => ({ id, title, status, detail, cases });
    return [
        check("secure-random", "安全随机数", capabilities.secureRandom ? "pass" : "error", capabilities.secureRandom ? "安全随机数可用。创建任务不依赖 randomUUID 的安全上下文限制。" : "缺少安全随机数能力，无法可靠创建任务标识。请更新浏览器或 WebView2 运行时。"),
        check("structured-clone", "画布数据复制", capabilities.structuredClone ? "pass" : "error", capabilities.structuredClone ? "画布数据复制能力可用。" : "运行时缺少画布所需的数据复制能力，请更新浏览器或 WebView2 运行时。"),
        check("indexed-db", "浏览器本地缓存", !capabilities.indexedDB || capabilities.storageWritable === false ? "error" : capabilities.storageTimedOut ? "warning" : capabilities.storageWritable === true ? "pass" : "unknown", !capabilities.indexedDB || capabilities.storageWritable === false ? "本地缓存无法写入，请检查隐私设置、存储空间或更新运行时。" : capabilities.storageTimedOut ? "缓存检查超时，尚未确认可写。请关闭占用存储的页面后重新检查。" : capabilities.storageWritable === true ? "已完成独立测试记录的写入、读取和清理。" : "尚未完成本地缓存写入检查。"),
        check("webgl", "图形加速", capabilities.webGL ? "unknown" : "warning", capabilities.webGL ? "图形接口可用，硬件加速状态需在实际预览中确认。" : "图形接口不可用，部分预览可能变慢。请检查远程桌面、显卡驱动或浏览器硬件加速设置。", ["ENV-0051"]),
        check("video-codec", "视频播放", capabilities.h264 ? "pass" : "warning", capabilities.h264 ? (capabilities.hevc ? "浏览器声明支持 H.264 和 HEVC；具体素材仍需实际解码。" : "浏览器声明支持 H.264，HEVC 素材可由本地视频工具生成兼容预览。") : "浏览器未声明 H.264 播放能力，请更新运行时并检查系统媒体组件。", ["ENV-0014", "ENV-0029"]),
    ];
}

// Use an isolated, uniquely named database. Never open or clear product stores.
// Late success after the deadline still closes and removes the probe database.
type StorageProbeResult = Pick<BrowserCapabilities, "storageWritable" | "storageTimedOut">;
export async function probeBrowserStorage(signal?: AbortSignal): Promise<StorageProbeResult> {
    if (signal?.aborted) return {};
    const probe = ++latestStorageProbe;
    const epoch = captureUserScopeEpoch();
    const publish = (result: StorageProbeResult) => {
        if (probe === latestStorageProbe && !signal?.aborted && userScopeEpochMatches(epoch)) {
            storageWritable = result.storageWritable;
            storageTimedOut = result.storageTimedOut ?? false;
        }
        return result;
    };
    try { if (typeof indexedDB === "undefined") return publish({ storageWritable: false }); }
    catch { return publish({ storageWritable: false }); }
    return new Promise<StorageProbeResult>((resolve) => {
        const name = `beeftv-environment-probe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        let settled = false;
        let database: IDBDatabase | undefined;
        const removeProbe = () => { try { return indexedDB.deleteDatabase(name); } catch { return undefined; } };
        const finish = (result?: boolean, timedOut = false) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            database?.close();
            removeProbe();
            const snapshot = { storageWritable: result, storageTimedOut: timedOut };
            resolve(signal?.aborted ? {} : publish(snapshot));
        };
        const timer = setTimeout(() => finish(undefined, true), 2000);
        const abort = () => finish();
        signal?.addEventListener("abort", abort, { once: true });
        try {
            const request = indexedDB.open(name, 1);
            request.onupgradeneeded = () => { request.result.createObjectStore("probe"); };
            request.onerror = () => { finish(false); removeProbe(); };
            request.onsuccess = () => {
                database = request.result;
                if (settled) { database.close(); removeProbe(); return; }
                try {
                const transaction = database.transaction("probe", "readwrite");
                const store = transaction.objectStore("probe");
                store.put("ok", "test");
                let verified = false;
                store.get("test").onsuccess = (event) => { verified = (event.target as IDBRequest).result === "ok"; };
                transaction.oncomplete = () => {
                    database?.close();
                    const cleanup = removeProbe();
                    if (!cleanup) { finish(); return; }
                    cleanup.onsuccess = () => finish(verified);
                    cleanup.onerror = () => finish();
                };
                transaction.onabort = () => { database?.close(); removeProbe(); finish(false); };
                } catch { database.close(); removeProbe(); finish(false); }
            };
        } catch { finish(false); }
    });
}
