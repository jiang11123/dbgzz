// Shared browser FFmpeg worker lifetime for canvas merge/trim/crop/audio.
// One executing owner at a time. warmFFmpeg may park a single idle worker;
// it must not hand the in-flight filesystem to a second owner.

export type CanvasFFmpegProgress = {
    phase: "loading" | "reading" | "encoding";
    progress: number;
};

export type FFmpegInstance = import("@ffmpeg/ffmpeg").FFmpeg;

export type FFmpegLease = {
    ffmpeg: FFmpegInstance;
    filePrefix: string;
};

export type FFmpegSpawn = (onProgress?: (progress: CanvasFFmpegProgress) => void) => Promise<FFmpegInstance>;

type QueuedLease = {
    work: (lease: FFmpegLease) => Promise<unknown>;
    signal?: AbortSignal;
    onProgress?: (progress: CanvasFFmpegProgress) => void;
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
    abortListener?: () => void;
    settled: boolean;
};

function abortError(signal?: AbortSignal): DOMException {
    if (signal?.reason instanceof DOMException) return signal.reason;
    const message = signal?.reason instanceof Error ? signal.reason.message : "The operation was aborted.";
    return new DOMException(message, "AbortError");
}

function isAbortLike(error: unknown, signal?: AbortSignal): boolean {
    if (signal?.aborted) return true;
    return (error instanceof DOMException && error.name === "AbortError") || (error instanceof Error && error.name === "AbortError");
}

async function defaultSpawn(onProgress?: (progress: CanvasFFmpegProgress) => void): Promise<FFmpegInstance> {
    if (typeof __BEEFTV_HEAVY_MEDIA_ENABLED__ !== "undefined" && !__BEEFTV_HEAVY_MEDIA_ENABLED__) {
        throw new Error("精简版未包含 FFmpeg 本地媒体工具；请安装完整媒体包或使用模型生成与原素材编排");
    }
    const [{ FFmpeg }, { default: ffmpegCoreURL }, { default: ffmpegWasmURL }] = await Promise.all([
        import("@ffmpeg/ffmpeg"),
        import("@ffmpeg/core?url"),
        import("@ffmpeg/core/wasm?url"),
    ]);
    const ffmpeg = new FFmpeg();
    onProgress?.({ phase: "loading", progress: 0 });
    try {
        await ffmpeg.load({ coreURL: ffmpegCoreURL, wasmURL: ffmpegWasmURL });
    } catch (cause) {
        ffmpeg.terminate();
        throw new Error("视频合并工具加载失败，请刷新页面后重试", { cause });
    }
    return ffmpeg;
}

export function createFFmpegSession(options: { spawn?: FFmpegSpawn } = {}) {
    const spawn = options.spawn ?? defaultSpawn;
    let idle: FFmpegInstance | null = null;
    let idleLoading: Promise<FFmpegInstance> | null = null;
    let seq = 0;
    let inflight: { item: QueuedLease; ffmpeg: FFmpegInstance | null } | null = null;
    const queue: QueuedLease[] = [];
    let pumping = false;
    let disposed = false;

    function detachAbort(item: QueuedLease) {
        if (item.abortListener && item.signal) item.signal.removeEventListener("abort", item.abortListener);
        item.abortListener = undefined;
    }

    function finishReject(item: QueuedLease, error: unknown) {
        if (item.settled) return;
        item.settled = true;
        detachAbort(item);
        item.reject(error);
    }

    function finishResolve(item: QueuedLease, value: unknown) {
        if (item.settled) return;
        item.settled = true;
        detachAbort(item);
        item.resolve(value);
    }

    function terminateWorker(ffmpeg: FFmpegInstance) {
        try {
            ffmpeg.terminate();
        } catch {
            /* worker already dead */
        }
        if (idle === ffmpeg) idle = null;
    }

    function parkWorker(ffmpeg: FFmpegInstance) {
        if (idle && idle !== ffmpeg) {
            terminateWorker(ffmpeg);
            return;
        }
        idle = ffmpeg;
    }

    async function takeWorker(onProgress?: (progress: CanvasFFmpegProgress) => void): Promise<FFmpegInstance> {
        const parked = idle;
        idle = null;
        if (parked) return parked;
        const loading = idleLoading;
        idleLoading = null;
        if (loading) return loading;
        return spawn(onProgress);
    }

    async function prewarm(onProgress?: (progress: CanvasFFmpegProgress) => void): Promise<FFmpegInstance> {
        if (disposed) throw abortError();
        if (idle) return idle;
        if (!idleLoading) {
            const loading = spawn(onProgress)
                .then((ffmpeg) => {
                    if (disposed) {
                        terminateWorker(ffmpeg);
                        throw abortError();
                    }
                    // Clearing idleLoading in takeWorker transfers ownership to
                    // that lease. A late prewarm completion must not kill it.
                    if (idleLoading === loading) {
                        parkWorker(ffmpeg);
                        return idle!;
                    }
                    return ffmpeg;
                })
                .finally(() => {
                    if (idleLoading === loading) idleLoading = null;
                });
            idleLoading = loading;
        }
        return idleLoading;
    }

    function withLease<T>(
        work: (lease: FFmpegLease) => Promise<T>,
        leaseOptions: { signal?: AbortSignal; onProgress?: (progress: CanvasFFmpegProgress) => void } = {},
    ): Promise<T> {
        const { signal, onProgress } = leaseOptions;
        if (disposed || signal?.aborted) return Promise.reject(abortError(signal));
        return new Promise<T>((resolve, reject) => {
            const item: QueuedLease = {
                work,
                signal,
                onProgress,
                resolve: (value) => resolve(value as T),
                reject,
                settled: false,
            };
            const abortListener = () => {
                const index = queue.indexOf(item);
                if (index >= 0) {
                    queue.splice(index, 1);
                    finishReject(item, abortError(signal));
                    return;
                }
                if (inflight?.item === item) {
                    if (inflight.ffmpeg) terminateWorker(inflight.ffmpeg);
                    // Loading can outlive cancellation. Reject the caller now;
                    // pump still owns and destroys any worker arriving later.
                    finishReject(item, abortError(signal));
                }
            };
            item.abortListener = abortListener;
            signal?.addEventListener("abort", abortListener, { once: true });
            queue.push(item);
            void pump();
        });
    }

    async function pump() {
        if (pumping) return;
        pumping = true;
        try {
            while (queue.length) {
                const item = queue.shift()!;
                if (item.signal?.aborted) {
                    finishReject(item, abortError(item.signal));
                    continue;
                }
                inflight = { item, ffmpeg: null };
                let ffmpeg: FFmpegInstance | undefined;
                try {
                    ffmpeg = await takeWorker(item.onProgress);
                    inflight.ffmpeg = ffmpeg;
                    if (disposed || item.settled || item.signal?.aborted) {
                        terminateWorker(ffmpeg);
                        finishReject(item, abortError(item.signal));
                        continue;
                    }
                    const result = await item.work({ ffmpeg, filePrefix: `s${++seq}_` });
                    if (disposed || item.signal?.aborted) {
                        terminateWorker(ffmpeg);
                        finishReject(item, abortError(item.signal));
                    } else {
                        parkWorker(ffmpeg);
                        finishResolve(item, result);
                    }
                } catch (error) {
                    if (ffmpeg) {
                        if (disposed || isAbortLike(error, item.signal) || item.signal?.aborted) terminateWorker(ffmpeg);
                        else parkWorker(ffmpeg);
                    }
                    finishReject(item, isAbortLike(error, item.signal) ? abortError(item.signal) : error);
                } finally {
                    inflight = null;
                }
            }
        } finally {
            pumping = false;
            if (queue.length) void pump();
        }
    }

    function dispose() {
        disposed = true;
        if (idle) terminateWorker(idle);
        idle = null;
        idleLoading = null;
        if (inflight?.ffmpeg) terminateWorker(inflight.ffmpeg);
        if (inflight) finishReject(inflight.item, abortError(inflight.item.signal));
        for (const item of queue) finishReject(item, abortError(item.signal));
        queue.length = 0;
    }

    return { prewarm, withLease, dispose };
}

let defaultSession = createFFmpegSession();

export function withFFmpegLease<T>(
    work: (lease: FFmpegLease) => Promise<T>,
    options?: { signal?: AbortSignal; onProgress?: (progress: CanvasFFmpegProgress) => void },
): Promise<T> {
    return defaultSession.withLease(work, options);
}

export function prewarmFFmpeg(onProgress?: (progress: CanvasFFmpegProgress) => void): Promise<FFmpegInstance> {
    return defaultSession.prewarm(onProgress);
}

export function resetCanvasFFmpegSessionForTests(options?: { spawn?: FFmpegSpawn }) {
    defaultSession.dispose();
    defaultSession = createFFmpegSession(options);
}
