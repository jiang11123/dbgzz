import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

mock.module("@/lib/canvas/canvas-drawing-excalidraw-document", () => ({
    createExcalidrawDrawingFromImage: (source: { dataUrl: string }) => ({
        snapshot: { elements: [{ id: "from-image", isDeleted: false }], files: { img: { dataURL: source.dataUrl } } },
        pageId: "page",
    }),
}));

import * as runtimeMode from "@/lib/runtime-mode";
import { getActiveUserScope, setActiveUserScope } from "@/lib/user-scope";
import { captureUserScope, UserScopeAbandonedError } from "@/lib/user-scope-guard";
import {
    CanvasDrawingCanonicalMissingError,
    createCanvasDrawingFromImage,
    loadCanvasDrawing,
    loadCanvasDrawingPreview,
    loadCanvasDrawingRender,
    peekCanvasDrawingCacheForTests,
    removeCanvasDrawing,
    replaceCanvasDrawingStoresForTests,
    resetCanvasDrawingStorageForTests,
    saveCanvasDrawing,
    setCanvasDrawingDigestDelayForTests,
    setCanvasDrawingStageBarrierForTests,
    type CanvasDrawingSnapshot,
} from "@/lib/canvas/canvas-drawing-storage";
import { apiClient } from "@/services/api/request";

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function switchScope(userId: string) {
    const previous = getActiveUserScope();
    setActiveUserScope(userId);
    return () => setActiveUserScope(previous);
}

function memoryStore<T>(values: Map<string, T>, hooks?: {
    beforeGet?: (key: string) => Promise<void> | void;
    beforeSet?: (key: string, value: T) => Promise<void> | void;
    beforeRemove?: (key: string) => Promise<void> | void;
}) {
    return {
        async getItem(key: string) {
            await hooks?.beforeGet?.(key);
            return values.get(key) ?? null;
        },
        async setItem(key: string, value: T) {
            await hooks?.beforeSet?.(key, value);
            values.set(key, value);
            return value;
        },
        async removeItem(key: string) {
            await hooks?.beforeRemove?.(key);
            values.delete(key);
        },
    };
}

function envelope(data: unknown, status = 200) {
    return { data: { code: 0, msg: "", data }, status, statusText: "OK", headers: {}, config: {} as never };
}

function failure(status: number, msg: string, reason?: string) {
    return { data: { code: status, msg, data: null, reason }, status, statusText: "ERR", headers: {}, config: {} as never };
}

function requestBody(config: { data?: unknown }) {
    const data = config.data;
    if (typeof data === "string") {
        try { return JSON.parse(data) as Record<string, unknown>; } catch { return {}; }
    }
    return data && typeof data === "object" ? data as Record<string, unknown> : {};
}

function snapshotOf(text: string) {
    return { elements: [{ id: text, isDeleted: false }] };
}

function drawingCacheKey(userScope: string, projectId = "p1", drawingId = "d1") {
    return `${userScope}:${projectId}:${drawingId}`;
}

function generationOwnedKeys(map: Map<string, unknown>, drawingKey: string) {
    const prefix = `${drawingKey}\0g`;
    return [...map.keys()].filter((key) => key.startsWith(prefix)).sort();
}

function drawingRecord(snapshot: unknown, revision: number, extras: Record<string, unknown> = {}) {
    return {
        drawing: {
            drawingId: "d1",
            engine: "excalidraw",
            revision,
            snapshot,
            shapeCount: 1,
            pageCount: 1,
            createdAt: "2026-10-02T00:00:00.000Z",
            updatedAt: "2026-10-02T00:00:00.000Z",
            ...extras,
        },
    };
}

async function withAdapter<T>(adapter: NonNullable<typeof apiClient.defaults.adapter>, run: () => Promise<T>) {
    const previous = apiClient.defaults.adapter;
    apiClient.defaults.adapter = adapter;
    try {
        return await run();
    } finally {
        apiClient.defaults.adapter = previous;
    }
}

const spies: Array<{ mockRestore: () => void }> = [];
const documents = new Map<string, unknown>();
const previews = new Map<string, Blob>();
const renders = new Map<string, unknown>();

function desktopBackend() {
    spies.push(spyOn(runtimeMode, "isNativeDesktopRuntime").mockReturnValue(true));
    spies.push(spyOn(runtimeMode, "isLocalRuntimeMode").mockReturnValue(true));
}

function installStores(hooks?: {
    beforeSet?: (key: string, value: unknown) => Promise<void> | void;
    beforeGet?: (key: string) => Promise<void> | void;
    previewBeforeSet?: (key: string, value: Blob) => Promise<void> | void;
    previewBeforeGet?: (key: string) => Promise<void> | void;
    previewBeforeRemove?: (key: string) => Promise<void> | void;
}) {
    documents.clear();
    previews.clear();
    renders.clear();
    replaceCanvasDrawingStoresForTests({
        documents: memoryStore(documents, { beforeSet: hooks?.beforeSet, beforeGet: hooks?.beforeGet }),
        previews: memoryStore(previews, {
            beforeSet: hooks?.previewBeforeSet,
            beforeGet: hooks?.previewBeforeGet,
            beforeRemove: hooks?.previewBeforeRemove,
        }),
        renders: memoryStore(renders as Map<string, never>),
    });
}

afterEach(() => {
    while (spies.length) spies.pop()?.mockRestore();
    resetCanvasDrawingStorageForTests();
    documents.clear();
    previews.clear();
    renders.clear();
});

describe("canvas drawing storage", () => {
    test("pending save failure then restart retains actual snapshot and blobs", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        installStores();
        const preview = new Blob(["preview-v1"], { type: "image/png" });
        const renderBlob = new Blob(["render-v1"], { type: "image/png" });
        try {
            await withAdapter(async (config) => {
                if (String(config.url).includes("/resources") && String(config.method).toLowerCase() === "post") {
                    return envelope({ resource: { id: "res-preview", status: "ready" } });
                }
                return failure(500, "工作区暂时无法保存");
            }, async () => {
                await expect(saveCanvasDrawing(
                    "p1",
                    "d1",
                    "excalidraw",
                    snapshotOf("keep-me"),
                    null,
                    preview,
                    { blob: renderBlob, pageId: "page", width: 8, height: 8, mimeType: "image/png", background: "white" },
                    captureUserScope(),
                )).rejects.toThrow(/工作区暂时无法保存/);
            });

            const cached = await peekCanvasDrawingCacheForTests("p1", "d1", "owner-a") as { draft?: { document: CanvasDrawingSnapshot } };
            expect(cached?.draft?.document.snapshot).toEqual(snapshotOf("keep-me"));
            expect(await previews.get("owner-a:p1:d1")?.text()).toBe("preview-v1");
            expect(await (renders.get("owner-a:p1:d1") as { blob: Blob } | undefined)?.blob.text()).toBe("render-v1");

            const loaded = await withAdapter(async () => failure(500, "读失败"), async () => loadCanvasDrawing("p1", "d1", captureUserScope()).catch((error) => error));
            expect(loaded).toBeInstanceOf(Error);
            expect((loaded as Error).message).toMatch(/读失败/);

            const recovered = await withAdapter(async (config) => {
                if (String(config.method).toLowerCase() === "get" && String(config.url).includes("/drawings/")) return failure(404, "画板不存在");
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => loadCanvasDrawing("p1", "d1", captureUserScope()));
            expect(recovered?.origin).toBe("draft");
            expect(recovered?.snapshot).toEqual(snapshotOf("keep-me"));
            expect(recovered?.canonicalMissing).toBe(true);
            expect(await loadCanvasDrawingPreview("p1", "d1", captureUserScope()).then((blob) => blob?.text())).toBe("preview-v1");
        } finally {
            restore();
        }
    });

    test("later edit during delayed reply is not lost", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        installStores();
        const gate = deferred();
        let drawingPuts = 0;
        const snapshots: unknown[] = [];
        try {
            await withAdapter(async (config) => {
                if (String(config.url).includes("/resources")) return envelope({ resource: { id: "res-1", status: "ready" } });
                if (String(config.method).toLowerCase() === "put" && String(config.url).includes("/drawings/")) {
                    const body = requestBody(config) as { drawing: { revision: number; snapshot: unknown } };
                    drawingPuts += 1;
                    snapshots.push(body.drawing.snapshot);
                    await gate.promise;
                    return envelope(drawingRecord(body.drawing.snapshot, (body.drawing.revision || 0) + 1));
                }
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                const first = saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("first"), null, new Blob(["a"]), undefined, captureUserScope());
                const deadline = Date.now() + 2000;
                while (Date.now() < deadline) {
                    const cached = await peekCanvasDrawingCacheForTests("p1", "d1", "owner-a") as { draft?: { document: CanvasDrawingSnapshot } };
                    if (cached?.draft?.document.snapshot) break;
                    await new Promise((resolve) => setTimeout(resolve, 0));
                }
                const second = saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("second"), null, new Blob(["b"]), undefined, captureUserScope());
                while (Date.now() < deadline) {
                    const cached = await peekCanvasDrawingCacheForTests("p1", "d1", "owner-a") as { draft?: { document: CanvasDrawingSnapshot } };
                    if (JSON.stringify(cached?.draft?.document.snapshot) === JSON.stringify(snapshotOf("second"))) break;
                    await new Promise((resolve) => setTimeout(resolve, 0));
                }
                gate.resolve();
                await first;
                const saved = await second;
                expect(saved.snapshot).toEqual(snapshotOf("second"));
                const cached = await peekCanvasDrawingCacheForTests("p1", "d1", "owner-a") as { committed?: CanvasDrawingSnapshot; draft?: { document: CanvasDrawingSnapshot } };
                expect(cached.draft?.document.snapshot ?? cached.committed?.snapshot).toEqual(snapshotOf("second"));
                expect(snapshots.at(-1)).toEqual(snapshotOf("second"));
                expect(drawingPuts).toBeGreaterThan(0);
            });
        } finally {
            restore();
        }
    });

    test("A-B-A during hash prevents the old epoch from publishing", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        installStores();
        const digest = deferred();
        const puts: string[] = [];
        let delayedOnce = false;
        setCanvasDrawingDigestDelayForTests(async () => {
            if (delayedOnce) return;
            delayedOnce = true;
            await digest.promise;
        });
        try {
            const firstEpoch = captureUserScope();
            await withAdapter(async (config) => {
                puts.push(`${(config as { expectedScope?: { epoch: number } }).expectedScope?.epoch ?? "none"} ${String(config.method)} ${String(config.url)}`);
                if (String(config.url).includes("/resources")) return envelope({ resource: { id: "res-new", status: "ready" } });
                return failure(500, "新纪元保存失败");
            }, async () => {
                const pending = saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("old"), null, new Blob(["old"]), undefined, firstEpoch);
                await new Promise((resolve) => setTimeout(resolve, 10));
                setActiveUserScope("owner-b");
                setActiveUserScope("owner-a");
                const secondEpoch = captureUserScope();
                expect(secondEpoch.epoch).not.toBe(firstEpoch.epoch);
                const second = saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("new"), null, new Blob(["new"]), undefined, secondEpoch);
                const settled = Promise.allSettled([pending, second]);
                const deadline = Date.now() + 2000;
                while (Date.now() < deadline) {
                    const cached = await peekCanvasDrawingCacheForTests("p1", "d1", "owner-a") as { draft?: { document: CanvasDrawingSnapshot } };
                    if (JSON.stringify(cached?.draft?.document.snapshot) === JSON.stringify(snapshotOf("new"))) break;
                    await new Promise((resolve) => setTimeout(resolve, 0));
                }
                digest.resolve();
                const [firstResult, secondResult] = await settled;
                expect(firstResult.status).toBe("rejected");
                expect(firstResult.status === "rejected" && firstResult.reason).toBeInstanceOf(UserScopeAbandonedError);
                expect(secondResult.status).toBe("rejected");
                expect(String(secondResult.status === "rejected" ? secondResult.reason : "")).toMatch(/新纪元保存失败/);
                expect(puts.filter((item) => item.startsWith(`${firstEpoch.epoch} `))).toEqual([]);
                const cached = await peekCanvasDrawingCacheForTests("p1", "d1", "owner-a") as { draft?: { document: CanvasDrawingSnapshot } };
                expect(cached.draft?.document.snapshot).toEqual(snapshotOf("new"));
            });
        } finally {
            setCanvasDrawingDigestDelayForTests();
            restore();
        }
    });

    test("native preview does not keep stale media after canonical change", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        installStores();
        documents.set("owner-a:p1:d1", {
            version: 3,
            committed: {
                version: 2,
                engine: "excalidraw",
                snapshot: snapshotOf("old"),
                revision: 2,
                updatedAt: "2026-10-01T00:00:00.000Z",
                shapeCount: 1,
                pageCount: 1,
                previewResourceId: "pv-old",
            },
        });
        previews.set("owner-a:p1:d1", new Blob(["old-preview"], { type: "image/png" }));
        try {
            const blob = await withAdapter(async (config) => {
                if (String(config.method).toLowerCase() === "get" && String(config.url).includes("/drawings/d1")) {
                    return envelope(drawingRecord(snapshotOf("remote"), 4, { previewResourceId: "pv-new" }));
                }
                if (String(config.url).includes("/resources/pv-new/file")) {
                    return { data: new Blob(["new-preview"], { type: "image/png" }), status: 200, statusText: "OK", headers: {}, config: {} as never };
                }
                if (String(config.url).includes("/resources/pv-old/file")) {
                    throw new Error("stale preview must not be read");
                }
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => loadCanvasDrawingPreview("p1", "d1", captureUserScope()));
            expect(await blob?.text()).toBe("new-preview");
        } finally {
            restore();
        }
    });

    test("native empty cache reads actual remote", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        installStores();
        try {
            const loaded = await withAdapter(async (config) => {
                if (String(config.method).toLowerCase() === "get" && String(config.url).includes("/drawings/d1")) {
                    return envelope(drawingRecord(snapshotOf("remote"), 4, { previewResourceId: "pv-1" }));
                }
                if (String(config.url).includes("/resources/pv-1/file")) {
                    return { data: new Blob(["remote-preview"], { type: "image/png" }), status: 200, statusText: "OK", headers: {}, config: {} as never };
                }
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                const document = await loadCanvasDrawing("p1", "d1", captureUserScope());
                const preview = await loadCanvasDrawingPreview("p1", "d1", captureUserScope());
                return { document, preview };
            });
            expect(loaded.document?.origin).toBe("canonical");
            expect(loaded.document?.revision).toBe(4);
            expect(loaded.document?.snapshot).toEqual(snapshotOf("remote"));
            expect(await loaded.preview?.text()).toBe("remote-preview");
        } finally {
            restore();
        }
    });

    test("real read error is not treated as success", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        installStores();
        documents.set("owner-a:p1:d1", { version: 2, engine: "excalidraw", snapshot: snapshotOf("stale"), revision: 9, updatedAt: "2026-10-01T00:00:00.000Z", shapeCount: 1, pageCount: 1 });
        try {
            await withAdapter(async () => failure(503, "服务暂时不可用，请稍后重试"), async () => {
                await expect(loadCanvasDrawing("p1", "d1", captureUserScope())).rejects.toThrow(/服务暂时不可用/);
            });
        } finally {
            restore();
        }
    });

    test("CAS conflict preserves the editor draft", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        installStores();
        try {
            await withAdapter(async (config) => {
                if (String(config.url).includes("/resources")) return envelope({ resource: { id: "res-1", status: "ready" } });
                if (String(config.method).toLowerCase() === "put" && String(config.url).includes("/drawings/")) {
                    return failure(409, "画板已有更新，已停止覆盖；请保留本地草稿并加载最新版本", "conflict");
                }
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                await expect(saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("mine"), null, new Blob(["p"]), undefined, captureUserScope()))
                    .rejects.toThrow(/画板已有更新/);
            });
            const cached = await peekCanvasDrawingCacheForTests("p1", "d1", "owner-a") as { draft?: { document: CanvasDrawingSnapshot; conflict?: boolean } };
            expect(cached.draft?.document.snapshot).toEqual(snapshotOf("mine"));
            expect(cached.draft?.conflict).toBe(true);
        } finally {
            restore();
        }
    });

    test("failed_precondition keeps the actual draft and blocks reimport of the old id", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        installStores();
        const puts: number[] = [];
        try {
            await withAdapter(async (config) => {
                if (String(config.url).includes("/resources")) return envelope({ resource: { id: "res-1", status: "ready" } });
                if (String(config.method).toLowerCase() === "put") {
                    puts.push(1);
                    return failure(409, "画板已删除，不能重新导入", "failed_precondition");
                }
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                await expect(saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("keep"), null, new Blob(["p"]), undefined, captureUserScope()))
                    .rejects.toBeInstanceOf(CanvasDrawingCanonicalMissingError);
                await expect(saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("keep-2"), null, new Blob(["q"]), undefined, captureUserScope()))
                    .rejects.toBeInstanceOf(CanvasDrawingCanonicalMissingError);
            });
            expect(puts).toEqual([1]);
            const cached = await peekCanvasDrawingCacheForTests("p1", "d1", "owner-a") as { draft?: { document: CanvasDrawingSnapshot; blockedReimport?: boolean } };
            expect(cached.draft?.document.snapshot).toEqual(snapshotOf("keep-2"));
            expect(cached.draft?.blockedReimport).toBe(true);
        } finally {
            restore();
        }
    });

    test("failed_precondition survives GET 404 and still blocks reimport", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        installStores();
        const puts: number[] = [];
        try {
            await withAdapter(async (config) => {
                if (String(config.url).includes("/resources")) return envelope({ resource: { id: "res-1", status: "ready" } });
                if (String(config.method).toLowerCase() === "put") {
                    puts.push(1);
                    return failure(409, "画板已删除，不能重新导入", "failed_precondition");
                }
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                await expect(saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("keep"), null, new Blob(["p"]), undefined, captureUserScope()))
                    .rejects.toBeInstanceOf(CanvasDrawingCanonicalMissingError);
            });

            const loaded = await withAdapter(async (config) => {
                if (String(config.method).toLowerCase() === "get") return failure(404, "画板不存在");
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => loadCanvasDrawing("p1", "d1", captureUserScope()));
            expect(loaded?.snapshot).toEqual(snapshotOf("keep"));
            expect(loaded?.canonicalMissing).toBe(true);

            await withAdapter(async (config) => {
                if (String(config.url).includes("/resources")) return envelope({ resource: { id: "res-2", status: "ready" } });
                if (String(config.method).toLowerCase() === "put") {
                    puts.push(1);
                    return envelope(drawingRecord(snapshotOf("resurrected"), 1));
                }
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                await expect(saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("keep-3"), loaded, new Blob(["q"]), undefined, captureUserScope()))
                    .rejects.toBeInstanceOf(CanvasDrawingCanonicalMissingError);
            });
            expect(puts).toEqual([1]);
            const cached = await peekCanvasDrawingCacheForTests("p1", "d1", "owner-a") as { draft?: { document: CanvasDrawingSnapshot; blockedReimport?: boolean } };
            expect(cached.draft?.document.snapshot).toEqual(snapshotOf("keep-3"));
            expect(cached.draft?.blockedReimport).toBe(true);
        } finally {
            restore();
        }
    });

    test("404 keeps recoverable draft and does not PUT deleted committed data", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        installStores();
        documents.set("owner-a:p1:d1", {
            version: 3,
            committed: { version: 2, engine: "excalidraw", snapshot: snapshotOf("was-saved"), revision: 3, updatedAt: "2026-10-01T00:00:00.000Z", shapeCount: 1, pageCount: 1 },
        });
        const puts: number[] = [];
        try {
            const loaded = await withAdapter(async (config) => {
                if (String(config.method).toLowerCase() === "get") return failure(404, "画板不存在");
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => loadCanvasDrawing("p1", "d1", captureUserScope()));
            expect(loaded?.canonicalMissing).toBe(true);
            expect(loaded?.snapshot).toEqual(snapshotOf("was-saved"));
            expect(loaded?.revision).toBe(3);

            await withAdapter(async (config) => {
                if (String(config.method).toLowerCase() === "put") {
                    puts.push(1);
                    return envelope(drawingRecord(snapshotOf("resurrected"), 1));
                }
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                await expect(saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("edit"), loaded, undefined, undefined, captureUserScope()))
                    .rejects.toBeInstanceOf(CanvasDrawingCanonicalMissingError);
            });
            expect(puts).toEqual([]);
        } finally {
            restore();
        }
    });

    test("delete prevents a stale GET from restoring the drawing", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        installStores();
        const staleGet = deferred();
        const gate = deferred();
        try {
            await withAdapter(async (config) => {
                if (String(config.method).toLowerCase() === "get") {
                    staleGet.resolve();
                    await gate.promise;
                    return envelope(drawingRecord(snapshotOf("stale"), 2));
                }
                if (String(config.method).toLowerCase() === "delete") return envelope({ id: "d1" });
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                const loading = loadCanvasDrawing("p1", "d1", captureUserScope());
                await staleGet.promise;
                await removeCanvasDrawing("p1", "d1", captureUserScope());
                gate.resolve();
                expect(await loading).toBeNull();
                expect(await loadCanvasDrawingPreview("p1", "d1", captureUserScope())).toBeNull();
            });
        } finally {
            restore();
        }
    });

    test("concurrent first saves complete two reads before either write and keep the newer draft", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        installStores();
        const reads: number[] = [];
        const writes: number[] = [];
        const bothRead = deferred();
        setCanvasDrawingStageBarrierForTests(async () => {
            reads.push(1);
            if (reads.length === 2) bothRead.resolve();
            await bothRead.promise;
        });
        const previousSet = documents.set.bind(documents);
        const documentStore = memoryStore(documents, {
            beforeSet: async () => {
                writes.push(reads.length);
            },
        });
        replaceCanvasDrawingStoresForTests({
            documents: documentStore,
            previews: memoryStore(previews),
            renders: memoryStore(renders as Map<string, never>),
        });
        void previousSet;
        const snapshots: unknown[] = [];
        try {
            await withAdapter(async (config) => {
                if (String(config.url).includes("/resources")) return envelope({ resource: { id: "res-1", status: "ready" } });
                if (String(config.method).toLowerCase() === "put") {
                    snapshots.push(requestBody(config).drawing?.snapshot);
                    return envelope(drawingRecord(requestBody(config).drawing?.snapshot, snapshots.length));
                }
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                const first = saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("first"), null, new Blob(["a"]), undefined, captureUserScope());
                const second = saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("second"), null, new Blob(["b"]), undefined, captureUserScope());
                const [firstResult, secondResult] = await Promise.all([first, second]);
                expect(writes.every((count) => count >= 2)).toBe(true);
                expect(firstResult.snapshot).toEqual(snapshotOf("second"));
                expect(secondResult.snapshot).toEqual(snapshotOf("second"));
                const cached = await peekCanvasDrawingCacheForTests("p1", "d1", "owner-a") as { draft?: { generation: number; document: CanvasDrawingSnapshot }; committed?: CanvasDrawingSnapshot; generationHighWater?: number };
                expect(cached.draft?.document.snapshot ?? cached.committed?.snapshot).toEqual(snapshotOf("second"));
                expect(cached.generationHighWater).toBeGreaterThanOrEqual(2);
                expect(snapshots.at(-1)).toEqual(snapshotOf("second"));
            });
        } finally {
            setCanvasDrawingStageBarrierForTests();
            restore();
        }
    });

    test("new edit during pending ack is not lost", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        installStores();
        const enteredPut = deferred();
        const releasePut = deferred();
        try {
            await withAdapter(async (config) => {
                if (String(config.url).includes("/resources")) return envelope({ resource: { id: "res-1", status: "ready" } });
                if (String(config.method).toLowerCase() === "put") {
                    const body = requestBody(config) as { drawing: { snapshot: unknown } };
                    if (JSON.stringify(body.drawing.snapshot) === JSON.stringify(snapshotOf("first"))) {
                        enteredPut.resolve();
                        await releasePut.promise;
                    }
                    return envelope(drawingRecord(body.drawing.snapshot, (body.drawing.revision || 0) + 1));
                }
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                const first = saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("first"), null, new Blob(["a"]), undefined, captureUserScope());
                await enteredPut.promise;
                const second = saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("second"), null, new Blob(["b"]), undefined, captureUserScope());
                const deadline = Date.now() + 2000;
                while (Date.now() < deadline) {
                    const cached = await peekCanvasDrawingCacheForTests("p1", "d1", "owner-a") as { draft?: { generation: number; document: CanvasDrawingSnapshot } };
                    if (JSON.stringify(cached?.draft?.document.snapshot) === JSON.stringify(snapshotOf("second"))) break;
                    await new Promise((resolve) => setTimeout(resolve, 0));
                }
                releasePut.resolve();
                await first;
                const saved = await second;
                expect(saved.snapshot).toEqual(snapshotOf("second"));
                const cached = await peekCanvasDrawingCacheForTests("p1", "d1", "owner-a") as { draft?: { document: CanvasDrawingSnapshot }; committed?: CanvasDrawingSnapshot; generationHighWater?: number };
                expect(cached.draft?.document.snapshot ?? cached.committed?.snapshot).toEqual(snapshotOf("second"));
                expect(cached.generationHighWater).toBeGreaterThanOrEqual(2);
            });
        } finally {
            restore();
        }
    });

    test("new edit during pending remove is not lost", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        installStores();
        const enteredDelete = deferred();
        const releaseDelete = deferred();
        try {
            await withAdapter(async (config) => {
                if (String(config.url).includes("/resources")) return envelope({ resource: { id: "res-1", status: "ready" } });
                if (String(config.method).toLowerCase() === "put") {
                    return envelope(drawingRecord(requestBody(config).drawing?.snapshot, 2));
                }
                if (String(config.method).toLowerCase() === "delete") {
                    enteredDelete.resolve();
                    await releaseDelete.promise;
                    return envelope({ id: "d1" });
                }
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                await saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("keep"), null, new Blob(["keep"]), undefined, captureUserScope());
                const removing = removeCanvasDrawing("p1", "d1", captureUserScope());
                await enteredDelete.promise;
                const saved = await saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("after-delete"), null, new Blob(["after"]), undefined, captureUserScope());
                releaseDelete.resolve();
                await removing;
                expect(saved.snapshot).toEqual(snapshotOf("after-delete"));
                const cached = await peekCanvasDrawingCacheForTests("p1", "d1", "owner-a") as { draft?: { document: CanvasDrawingSnapshot }; committed?: CanvasDrawingSnapshot };
                expect(cached.draft?.document.snapshot ?? cached.committed?.snapshot).toEqual(snapshotOf("after-delete"));
                expect(await previews.get("owner-a:p1:d1")?.text()).toBe("after");
            });
        } finally {
            restore();
        }
    });

    test("delayed first blob write cannot replace the newer preview after backend failure", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        const firstPreview = deferred();
        const releaseFirstPreview = deferred();
        let previewSets = 0;
        installStores({
            previewBeforeSet: async (key, value) => {
                if (key.includes("\0g")) return;
                previewSets += 1;
                if (previewSets === 1) {
                    expect(await value.text()).toBe("blob-a");
                    firstPreview.resolve();
                    await releaseFirstPreview.promise;
                }
            },
        });
        try {
            await withAdapter(async (config) => {
                if (String(config.url).includes("/resources")) return envelope({ resource: { id: "res-1", status: "ready" } });
                if (String(config.method).toLowerCase() === "put") return failure(500, "工作区暂时无法保存");
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                const first = saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("first"), null, new Blob(["blob-a"]), { blob: new Blob(["render-a"]), pageId: "page", width: 8, height: 8, mimeType: "image/png", background: "white" }, captureUserScope());
                await firstPreview.promise;
                const firstResult = first.then((value) => ({ ok: true as const, value }), (error) => ({ ok: false as const, error }));
                const second = saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("second"), null, new Blob(["blob-b"]), { blob: new Blob(["render-b"]), pageId: "page", width: 8, height: 8, mimeType: "image/png", background: "white" }, captureUserScope());
                const secondResult = second.then((value) => ({ ok: true as const, value }), (error) => ({ ok: false as const, error }));
                releaseFirstPreview.resolve();
                const firstSettled = await firstResult;
                const secondSettled = await secondResult;
                expect(firstSettled.ok).toBe(false);
                expect(String(firstSettled.ok ? "" : firstSettled.error)).toMatch(/工作区暂时无法保存/);
                expect(secondSettled.ok).toBe(false);
                expect(String(secondSettled.ok ? "" : secondSettled.error)).toMatch(/工作区暂时无法保存/);
                const cached = await peekCanvasDrawingCacheForTests("p1", "d1", "owner-a") as { draft?: { document: CanvasDrawingSnapshot } };
                expect(cached.draft?.document.snapshot).toEqual(snapshotOf("second"));
                expect(await previews.get("owner-a:p1:d1")?.text()).toBe("blob-b");

                const recovered = await withAdapter(async (config) => {
                    if (String(config.method).toLowerCase() === "get" && String(config.url).includes("/drawings/")) return failure(404, "画板不存在");
                    throw new Error(`unexpected ${config.method} ${config.url}`);
                }, async () => loadCanvasDrawing("p1", "d1", captureUserScope()));
                expect(recovered?.snapshot).toEqual(snapshotOf("second"));
                expect(await loadCanvasDrawingPreview("p1", "d1", captureUserScope()).then((blob) => blob?.text())).toBe("blob-b");
            });
        } finally {
            restore();
        }
    });

    test("stale GET cannot hide a newer committed revision or live draft", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        installStores();
        const enteredGet = deferred();
        const releaseGet = deferred();
        try {
            const loading = withAdapter(async (config) => {
                if (String(config.method).toLowerCase() === "get" && String(config.url).includes("/drawings/")) {
                    enteredGet.resolve();
                    await releaseGet.promise;
                    return envelope(drawingRecord(snapshotOf("stale"), 1));
                }
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => loadCanvasDrawing("p1", "d1", captureUserScope()));

            await enteredGet.promise;
            await withAdapter(async (config) => {
                if (String(config.url).includes("/resources")) return envelope({ resource: { id: "res-new", status: "ready" } });
                if (String(config.method).toLowerCase() === "put") return envelope(drawingRecord(snapshotOf("fresh"), 4));
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("fresh"), null, new Blob(["fresh"]), undefined, captureUserScope()));

            releaseGet.resolve();
            const loaded = await loading;
            expect(loaded?.snapshot).toEqual(snapshotOf("fresh"));
            expect(loaded?.revision === 4 || loaded?.origin === "draft").toBe(true);
        } finally {
            restore();
        }
    });

    test("failing createCanvasDrawingFromImage keeps the draft and does not DELETE", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        installStores();
        const methods: string[] = [];
        const originalImage = globalThis.Image;
        const originalDocument = globalThis.document;
        const originalWindow = globalThis.window;
        class FakeImage {
            onload: (() => void) | null = null;
            onerror: (() => void) | null = null;
            naturalWidth = 8;
            naturalHeight = 8;
            width = 8;
            height = 8;
            set src(_value: string) {
                this.onload?.();
            }
        }
        (globalThis as { Image: typeof Image }).Image = FakeImage as unknown as typeof Image;
        globalThis.document = {
            createElement: (tag: string) => {
                if (tag !== "canvas") throw new Error(`unexpected element ${tag}`);
                return {
                    width: 0,
                    height: 0,
                    getContext: () => ({ fillStyle: "", fillRect() {}, drawImage() {} }),
                    toBlob: (callback: (blob: Blob | null) => void) => callback(new Blob(["from-image"], { type: "image/png" })),
                };
            },
        } as never;
        globalThis.window = {
            document: globalThis.document,
            location: { protocol: "http:" },
            Image: FakeImage,
        } as never;
        const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        try {
            await withAdapter(async (config) => {
                methods.push(`${String(config.method).toLowerCase()} ${String(config.url)}`);
                if (String(config.url).includes("/resources")) return envelope({ resource: { id: "res-1", status: "ready" } });
                if (String(config.method).toLowerCase() === "put") return failure(500, "工作区暂时无法保存");
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                await expect(createCanvasDrawingFromImage("p1", "d1", "excalidraw", { url: png, name: "来源.png" }, captureUserScope()))
                    .rejects.toThrow(/工作区暂时无法保存/);
            });
            expect(methods.some((item) => item.startsWith("delete "))).toBe(false);
            const cached = await peekCanvasDrawingCacheForTests("p1", "d1", "owner-a") as { draft?: { document: CanvasDrawingSnapshot } };
            expect(cached.draft?.document.snapshot).toBeDefined();
            expect(await previews.get("owner-a:p1:d1")?.text()).toBe("from-image");
        } finally {
            (globalThis as { Image: typeof Image }).Image = originalImage;
            if (originalDocument) globalThis.document = originalDocument;
            else delete (globalThis as { document?: unknown }).document;
            if (originalWindow) globalThis.window = originalWindow;
            else delete (globalThis as { window?: unknown }).window;
            restore();
        }
    });

    test("multiple saves then ack leave only the published blobs", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        installStores();
        const key = drawingCacheKey("owner-a");
        try {
            await withAdapter(async (config) => {
                if (String(config.url).includes("/resources")) return envelope({ resource: { id: "res-1", status: "ready" } });
                if (String(config.method).toLowerCase() === "put") {
                    const body = requestBody(config) as { drawing: { snapshot: unknown; revision: number } };
                    return envelope(drawingRecord(body.drawing.snapshot, (body.drawing.revision || 0) + 1));
                }
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                await saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("first"), null, new Blob(["blob-a"]), { blob: new Blob(["render-a"]), pageId: "page", width: 8, height: 8, mimeType: "image/png", background: "white" }, captureUserScope());
                await saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("second"), null, new Blob(["blob-b"]), { blob: new Blob(["render-b"]), pageId: "page", width: 8, height: 8, mimeType: "image/png", background: "white" }, captureUserScope());
            });
            expect(generationOwnedKeys(previews as Map<string, unknown>, key)).toEqual([]);
            expect(generationOwnedKeys(renders, key)).toEqual([]);
            expect(await previews.get(key)?.text()).toBe("blob-b");
            expect(await (renders.get(key) as { blob: Blob } | undefined)?.blob.text()).toBe("render-b");
            const cached = await peekCanvasDrawingCacheForTests("p1", "d1", "owner-a") as { blobGenerations?: number[]; draft?: unknown };
            expect(cached.draft).toBeUndefined();
            expect(cached.blobGenerations ?? []).toEqual([]);
        } finally {
            restore();
        }
    });

    test("failed submit keeps the recoverable generation blobs", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        installStores();
        const key = drawingCacheKey("owner-a");
        try {
            await withAdapter(async (config) => {
                if (String(config.url).includes("/resources")) return envelope({ resource: { id: "res-1", status: "ready" } });
                if (String(config.method).toLowerCase() === "put") return failure(500, "工作区暂时无法保存");
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                await expect(saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("keep"), null, new Blob(["keep-preview"]), { blob: new Blob(["keep-render"]), pageId: "page", width: 8, height: 8, mimeType: "image/png", background: "white" }, captureUserScope()))
                    .rejects.toThrow(/工作区暂时无法保存/);
            });
            expect(generationOwnedKeys(previews as Map<string, unknown>, key)).toEqual([`${key}\0g1`]);
            expect(await previews.get(`${key}\0g1`)?.text()).toBe("keep-preview");
            expect(await (renders.get(`${key}\0g1`) as { blob: Blob } | undefined)?.blob.text()).toBe("keep-render");
            expect(await loadCanvasDrawingPreview("p1", "d1", captureUserScope()).then((blob) => blob?.text())).toBe("keep-preview");
        } finally {
            restore();
        }
    });

    test("unknown submit keeps the recoverable generation blobs", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        installStores();
        const key = drawingCacheKey("owner-a");
        try {
            await withAdapter(async (config) => {
                if (String(config.url).includes("/resources")) return envelope({ resource: { id: "res-1", status: "ready" } });
                if (String(config.method).toLowerCase() === "put") throw new Error("网络中断");
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                await expect(saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("keep"), null, new Blob(["keep-preview"]), { blob: new Blob(["keep-render"]), pageId: "page", width: 8, height: 8, mimeType: "image/png", background: "white" }, captureUserScope()))
                    .rejects.toThrow(/网络中断/);
            });
            expect(generationOwnedKeys(previews as Map<string, unknown>, key)).toEqual([`${key}\0g1`]);
            expect(await previews.get(`${key}\0g1`)?.text()).toBe("keep-preview");
            expect(await loadCanvasDrawingPreview("p1", "d1", captureUserScope()).then((blob) => blob?.text())).toBe("keep-preview");
            const cached = await peekCanvasDrawingCacheForTests("p1", "d1", "owner-a") as { draft?: { generation: number }; blobGenerations?: number[] };
            expect(cached.draft?.generation).toBe(1);
            expect(cached.blobGenerations).toEqual([1]);
        } finally {
            restore();
        }
    });

    test("old ack during a newer draft keeps the newer generation pair", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        installStores();
        const key = drawingCacheKey("owner-a");
        const enteredFirst = deferred();
        const releaseFirst = deferred();
        const enteredSecond = deferred();
        const releaseSecond = deferred();
        try {
            await withAdapter(async (config) => {
                if (String(config.url).includes("/resources")) return envelope({ resource: { id: "res-1", status: "ready" } });
                if (String(config.method).toLowerCase() === "put") {
                    const body = requestBody(config) as { drawing: { snapshot: unknown; revision: number } };
                    if (JSON.stringify(body.drawing.snapshot) === JSON.stringify(snapshotOf("first"))) {
                        enteredFirst.resolve();
                        await releaseFirst.promise;
                    } else {
                        enteredSecond.resolve();
                        await releaseSecond.promise;
                    }
                    return envelope(drawingRecord(body.drawing.snapshot, (body.drawing.revision || 0) + 1));
                }
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                const first = saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("first"), null, new Blob(["blob-a"]), { blob: new Blob(["render-a"]), pageId: "page", width: 8, height: 8, mimeType: "image/png", background: "white" }, captureUserScope());
                await enteredFirst.promise;
                const second = saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("second"), null, new Blob(["blob-b"]), { blob: new Blob(["render-b"]), pageId: "page", width: 8, height: 8, mimeType: "image/png", background: "white" }, captureUserScope());
                const deadline = Date.now() + 2000;
                while (Date.now() < deadline) {
                    const cached = await peekCanvasDrawingCacheForTests("p1", "d1", "owner-a") as { draft?: { generation: number } };
                    if (cached?.draft?.generation === 2) break;
                    await new Promise((resolve) => setTimeout(resolve, 0));
                }
                releaseFirst.resolve();
                await first;
                expect(generationOwnedKeys(previews as Map<string, unknown>, key)).toEqual([`${key}\0g2`]);
                expect(await previews.get(`${key}\0g2`)?.text()).toBe("blob-b");
                expect(await loadCanvasDrawingPreview("p1", "d1", captureUserScope()).then((blob) => blob?.text())).toBe("blob-b");
                releaseSecond.resolve();
                await second;
            });
        } finally {
            restore();
        }
    });

    test("draft preview does not fall back to a cleaned published blob", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        installStores();
        const key = drawingCacheKey("owner-a");
        const enteredFirst = deferred();
        const releaseFirst = deferred();
        const enteredSecond = deferred();
        const releaseSecond = deferred();
        try {
            await withAdapter(async (config) => {
                if (String(config.url).includes("/resources")) return envelope({ resource: { id: "res-1", status: "ready" } });
                if (String(config.method).toLowerCase() === "put") {
                    const body = requestBody(config) as { drawing: { snapshot: unknown; revision: number } };
                    if (JSON.stringify(body.drawing.snapshot) === JSON.stringify(snapshotOf("first"))) {
                        enteredFirst.resolve();
                        await releaseFirst.promise;
                    } else {
                        enteredSecond.resolve();
                        await releaseSecond.promise;
                    }
                    return envelope(drawingRecord(body.drawing.snapshot, (body.drawing.revision || 0) + 1));
                }
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                const first = saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("first"), null, new Blob(["blob-a"]), undefined, captureUserScope());
                await enteredFirst.promise;
                const second = saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("second"), null, new Blob(["blob-b"]), undefined, captureUserScope());
                const deadline = Date.now() + 2000;
                while (Date.now() < deadline) {
                    const cached = await peekCanvasDrawingCacheForTests("p1", "d1", "owner-a") as { draft?: { generation: number } };
                    if (cached?.draft?.generation === 2) break;
                    await new Promise((resolve) => setTimeout(resolve, 0));
                }
                releaseFirst.resolve();
                await first;
                previews.delete(`${key}\0g2`);
                expect(await previews.get(key)?.text()).toBe("blob-b");
                expect(await loadCanvasDrawingPreview("p1", "d1", captureUserScope())).toBeNull();
                releaseSecond.resolve();
                await second;
            });
        } finally {
            restore();
        }
    });

    test("delete cleanup does not drop another drawing or scope", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        installStores();
        const keepKey = drawingCacheKey("owner-a", "p1", "d2");
        const otherScope = drawingCacheKey("owner-b");
        const dropped = drawingCacheKey("owner-a");
        try {
            await withAdapter(async (config) => {
                if (String(config.url).includes("/resources")) return envelope({ resource: { id: "res-1", status: "ready" } });
                if (String(config.method).toLowerCase() === "put") {
                    const body = requestBody(config) as { drawing: { snapshot: unknown; revision: number } };
                    if (JSON.stringify(body.drawing.snapshot) === JSON.stringify(snapshotOf("drop-2"))) {
                        return failure(500, "工作区暂时无法保存");
                    }
                    return envelope(drawingRecord(body.drawing.snapshot, (body.drawing.revision || 0) + 1));
                }
                if (String(config.method).toLowerCase() === "delete") return envelope({ id: "d1" });
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                await saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("drop"), null, new Blob(["drop-a"]), { blob: new Blob(["drop-r"]), pageId: "page", width: 8, height: 8, mimeType: "image/png", background: "white" }, captureUserScope());
                await saveCanvasDrawing("p1", "d2", "excalidraw", snapshotOf("keep"), null, new Blob(["keep-a"]), { blob: new Blob(["keep-r"]), pageId: "page", width: 8, height: 8, mimeType: "image/png", background: "white" }, captureUserScope());
                const restoreB = switchScope("owner-b");
                await saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("other"), null, new Blob(["other-a"]), { blob: new Blob(["other-r"]), pageId: "page", width: 8, height: 8, mimeType: "image/png", background: "white" }, captureUserScope());
                restoreB();
                await expect(saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("drop-2"), null, new Blob(["drop-b"]), { blob: new Blob(["drop-r2"]), pageId: "page", width: 8, height: 8, mimeType: "image/png", background: "white" }, captureUserScope()))
                    .rejects.toThrow(/工作区暂时无法保存/);
                expect(generationOwnedKeys(previews as Map<string, unknown>, dropped)).toEqual([`${dropped}\0g2`]);
                await removeCanvasDrawing("p1", "d1", captureUserScope());
            });
            expect([...previews.keys()].filter((key) => key === dropped || key.startsWith(`${dropped}\0g`))).toEqual([]);
            expect([...renders.keys()].filter((key) => key === dropped || key.startsWith(`${dropped}\0g`))).toEqual([]);
            expect(await previews.get(keepKey)?.text()).toBe("keep-a");
            expect(generationOwnedKeys(previews as Map<string, unknown>, keepKey)).toEqual([]);
            expect(await previews.get(otherScope)?.text()).toBe("other-a");
            expect(await (renders.get(otherScope) as { blob: Blob } | undefined)?.blob.text()).toBe("other-r");
        } finally {
            restore();
        }
    });

    test("thrown generation blob read then later ack reclaims the leaked in-flight generation", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        let throwGenRead = true;
        installStores({
            previewBeforeGet: async (key) => {
                if (throwGenRead && key.includes("\0g")) {
                    throwGenRead = false;
                    throw new Error("preview store read failed");
                }
            },
        });
        const key = drawingCacheKey("owner-a");
        try {
            await withAdapter(async (config) => {
                if (String(config.url).includes("/resources")) return envelope({ resource: { id: "res-1", status: "ready" } });
                if (String(config.method).toLowerCase() === "put") {
                    const body = requestBody(config) as { drawing: { snapshot: unknown; revision: number } };
                    return envelope(drawingRecord(body.drawing.snapshot, (body.drawing.revision || 0) + 1));
                }
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                await expect(saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("first"), null, new Blob(["blob-a"]), { blob: new Blob(["render-a"]), pageId: "page", width: 8, height: 8, mimeType: "image/png", background: "white" }, captureUserScope()))
                    .rejects.toThrow(/preview store read failed/);
                await saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("second"), null, new Blob(["blob-b"]), { blob: new Blob(["render-b"]), pageId: "page", width: 8, height: 8, mimeType: "image/png", background: "white" }, captureUserScope());
            });
            expect(generationOwnedKeys(previews as Map<string, unknown>, key)).toEqual([]);
            expect(await previews.get(key)?.text()).toBe("blob-b");
        } finally {
            restore();
        }
    });

    test("legacy snapshot published blobs remain readable without a server PUT", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        installStores();
        const key = drawingCacheKey("owner-a");
        documents.set(key, {
            version: 2,
            engine: "excalidraw",
            snapshot: snapshotOf("legacy"),
            revision: 3,
            updatedAt: "2026-10-01T00:00:00.000Z",
            shapeCount: 1,
            pageCount: 1,
        });
        previews.set(key, new Blob(["legacy-preview"], { type: "image/png" }));
        renders.set(key, {
            blob: new Blob(["legacy-render"], { type: "image/png" }),
            pageId: "page",
            width: 8,
            height: 8,
            mimeType: "image/png",
            background: "white",
            version: 1,
            revision: 3,
            updatedAt: "2026-10-01T00:00:00.000Z",
        });
        const puts: string[] = [];
        try {
            const loaded = await withAdapter(async (config) => {
                if (String(config.method).toLowerCase() === "put") {
                    puts.push(`${config.method} ${config.url}`);
                    throw new Error("legacy load must not PUT");
                }
                if (String(config.method).toLowerCase() === "get" && String(config.url).includes("/drawings/")) {
                    return failure(404, "画板不存在");
                }
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                const preview = await loadCanvasDrawingPreview("p1", "d1", captureUserScope());
                const render = await loadCanvasDrawingRender("p1", "d1", captureUserScope());
                const document = await loadCanvasDrawing("p1", "d1", captureUserScope());
                return { preview, render, document };
            });
            expect(await loaded.preview?.text()).toBe("legacy-preview");
            expect(await loaded.render?.blob.text()).toBe("legacy-render");
            expect(loaded.document?.snapshot).toEqual(snapshotOf("legacy"));
            expect(await previews.get(`${key}\0g1`)?.text()).toBe("legacy-preview");
            expect(puts).toEqual([]);
        } finally {
            restore();
        }
    });

    test("reclaim failure does not mask an unknown network error", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        installStores({
            previewBeforeRemove: async (key) => {
                if (key.includes("\0g1")) throw new Error("reclaim failed");
            },
        });
        const enteredFirst = deferred();
        const releaseFirst = deferred();
        try {
            await withAdapter(async (config) => {
                if (String(config.url).includes("/resources")) return envelope({ resource: { id: "res-1", status: "ready" } });
                if (String(config.method).toLowerCase() === "put") {
                    const body = requestBody(config) as { drawing: { snapshot: unknown; revision: number } };
                    if (JSON.stringify(body.drawing.snapshot) === JSON.stringify(snapshotOf("first"))) {
                        enteredFirst.resolve();
                        await releaseFirst.promise;
                        throw new Error("网络中断");
                    }
                    return envelope(drawingRecord(body.drawing.snapshot, (body.drawing.revision || 0) + 1));
                }
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                const first = saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("first"), null, new Blob(["blob-a"]), { blob: new Blob(["render-a"]), pageId: "page", width: 8, height: 8, mimeType: "image/png", background: "white" }, captureUserScope());
                await enteredFirst.promise;
                const second = saveCanvasDrawing("p1", "d1", "excalidraw", snapshotOf("second"), null, new Blob(["blob-b"]), { blob: new Blob(["render-b"]), pageId: "page", width: 8, height: 8, mimeType: "image/png", background: "white" }, captureUserScope());
                const deadline = Date.now() + 2000;
                while (Date.now() < deadline) {
                    const cached = await peekCanvasDrawingCacheForTests("p1", "d1", "owner-a") as { draft?: { generation: number } };
                    if (cached?.draft?.generation === 2) break;
                    await new Promise((resolve) => setTimeout(resolve, 0));
                }
                releaseFirst.resolve();
                await expect(first).rejects.toThrow(/网络中断/);
                await second;
            });
        } finally {
            restore();
        }
    });
});
