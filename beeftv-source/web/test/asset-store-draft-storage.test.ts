import { afterEach, describe, expect, spyOn, test } from "bun:test";
import localforage from "localforage";

import * as runtimeMode from "@/lib/runtime-mode";
import { getActiveUserScope, setActiveUserScope } from "@/lib/user-scope";
import { captureUserScope } from "@/lib/user-scope-guard";
import { apiClient } from "@/services/api/request";
import { persistWorkspaceAssetChanges, resetWorkspaceAssetCommitStateForTests } from "@/services/workspace-asset-repository";
import {
    ackAssetStoreDraft,
    flushAssetStorePersistence,
    hydrateAssetStoreDrafts,
    peekAssetStoreDraft,
    resetAssetStoreDraftsForTests,
    unloadAssetStoreDraftsForTests,
    useAssetStore,
    type Asset,
} from "@/stores/use-asset-store";

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

function isDraftsKey(key: unknown) {
    return String(key).includes("asset_store_drafts");
}

function textAsset(id: string, title: string): Asset {
    return {
        id,
        kind: "text",
        title,
        coverUrl: "",
        tags: [],
        category: "other",
        status: "confirmed",
        source: "手动添加",
        data: { content: "hello" },
        createdAt: "2026-10-02T00:00:00.000Z",
        updatedAt: "2026-10-02T00:00:00.000Z",
    };
}

function envelope(data: unknown, status = 200) {
    return { data: { code: 0, msg: "", data }, status, statusText: "OK", headers: {}, config: {} as never };
}

async function waitFor(predicate: () => boolean, label: string) {
    const deadline = Date.now() + 2000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error(label);
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

const spies: Array<{ mockRestore: () => void }> = [];

function desktopBackend() {
    spies.push(spyOn(runtimeMode, "isNativeDesktopRuntime").mockReturnValue(true));
    spies.push(spyOn(runtimeMode, "isLocalRuntimeMode").mockReturnValue(true));
}

afterEach(async () => {
    while (spies.length) spies.pop()?.mockRestore();
    useAssetStore.setState({ assets: [] });
    resetWorkspaceAssetCommitStateForTests();
    await resetAssetStoreDraftsForTests();
});

describe("asset store durable draft storage", () => {
    test("a delayed draft hydrate cannot project into a later A to B to A epoch", async () => {
        const restore = switchScope("owner-a");
        const originalWindow = globalThis.window;
        globalThis.window = originalWindow ?? ({ localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } } as never);
        const entered = deferred();
        const gate = deferred();
        const getItem = spyOn(localforage, "getItem").mockImplementation(async (key) => {
            if (!isDraftsKey(key)) return null;
            entered.resolve();
            await gate.promise;
            return JSON.stringify({ drafts: { "asset-1": { kind: "upsert", version: 1, asset: textAsset("asset-1", "旧草稿") } } });
        });
        try {
            unloadAssetStoreDraftsForTests();
            const hydrating = hydrateAssetStoreDrafts("owner-a");
            await entered.promise;
            setActiveUserScope("owner-b");
            setActiveUserScope("owner-a");
            useAssetStore.setState({ assets: [textAsset("asset-1", "当前画面")] });
            gate.resolve();
            await hydrating;
            expect(useAssetStore.getState().assets[0]?.title).toBe("当前画面");
            expect(peekAssetStoreDraft("owner-a", "asset-1")?.asset?.title).toBe("旧草稿");
        } finally {
            gate.resolve();
            getItem.mockRestore();
            if (!originalWindow) delete (globalThis as { window?: unknown }).window;
            restore();
        }
    });

    test("serializes draft writes per userScope and keeps the later immutable document", async () => {
        const restore = switchScope("owner-a");
        const originalWindow = globalThis.window;
        globalThis.window = originalWindow ?? ({ localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } } as never);
        const memory = new Map<string, string>();
        const draftWrites: Array<{ value: string; resolve: () => void }> = [];
        const getItem = spyOn(localforage, "getItem").mockImplementation(async (key) => memory.get(String(key)) ?? null);
        const setItem = spyOn(localforage, "setItem").mockImplementation(async (key, value) => {
            if (isDraftsKey(key)) {
                const gate = deferred();
                draftWrites.push({ value: String(value), resolve: () => gate.resolve() });
                await gate.promise;
            }
            memory.set(String(key), String(value));
            return value;
        });
        const removeItem = spyOn(localforage, "removeItem").mockImplementation(async (key) => {
            memory.delete(String(key));
        });

        try {
            const id = useAssetStore.getState().addAsset({
                kind: "text",
                title: "第一版",
                coverUrl: "",
                tags: [],
                category: "other",
                status: "confirmed",
                source: "手动添加",
                data: { content: "v1" },
            });
            await waitFor(() => draftWrites.length === 1, "first draft setItem");
            useAssetStore.getState().updateAsset(id, { title: "第二版" });
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(draftWrites.length).toBe(1);
            expect(draftWrites[0]?.value).toContain("第一版");
            expect(draftWrites[0]?.value).not.toContain("第二版");

            draftWrites[0]?.resolve();
            await waitFor(() => draftWrites.length === 2, "second draft setItem");
            expect(draftWrites[1]?.value).toContain("第二版");
            draftWrites[1]?.resolve();
            await flushAssetStorePersistence(captureUserScope());

            const stored = [...memory.entries()].find(([key]) => isDraftsKey(key))?.[1] ?? "";
            expect(stored).toContain("第二版");
            expect(JSON.parse(stored).drafts[id].asset.title).toBe("第二版");
        } finally {
            for (const write of draftWrites) write.resolve();
            getItem.mockRestore();
            setItem.mockRestore();
            removeItem.mockRestore();
            if (!originalWindow) delete (globalThis as { window?: unknown }).window;
            restore();
        }
    });

    test("flush observes a draft write failure after the operation has already settled", async () => {
        const restore = switchScope("owner-a");
        const originalWindow = globalThis.window;
        globalThis.window = originalWindow ?? ({ localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } } as never);
        const memory = new Map<string, string>();
        const getItem = spyOn(localforage, "getItem").mockImplementation(async (key) => memory.get(String(key)) ?? null);
        const setItem = spyOn(localforage, "setItem").mockImplementation(async (key, value) => {
            if (isDraftsKey(key)) throw new Error("disk full");
            memory.set(String(key), String(value));
            return value;
        });
        const removeItem = spyOn(localforage, "removeItem").mockImplementation(async (key) => {
            memory.delete(String(key));
        });

        try {
            useAssetStore.getState().addAsset({
                kind: "text",
                title: "写失败",
                coverUrl: "",
                tags: [],
                category: "other",
                status: "confirmed",
                source: "手动添加",
                data: { content: "x" },
            });
            await expect(flushAssetStorePersistence(captureUserScope())).rejects.toThrow("disk full");
            await expect(flushAssetStorePersistence(captureUserScope())).rejects.toThrow("disk full");
        } finally {
            getItem.mockRestore();
            setItem.mockRestore();
            removeItem.mockRestore();
            if (!originalWindow) delete (globalThis as { window?: unknown }).window;
            restore();
        }
    });

    test("draft version stays monotonic after ack so an older ack cannot match a new edit", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        const previous = apiClient.defaults.adapter;
        apiClient.defaults.adapter = async (config) => {
            const payload = typeof config.data === "string" ? JSON.parse(config.data) : config.data;
            return envelope({ asset: { id: payload?.asset?.id, title: payload?.asset?.title, createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" } });
        };
        try {
            const id = useAssetStore.getState().addAsset({
                kind: "text",
                title: "第一版",
                coverUrl: "",
                tags: [],
                category: "other",
                status: "confirmed",
                source: "手动添加",
                data: { content: "v1" },
            });
            expect(peekAssetStoreDraft("owner-a", id)?.version).toBe(1);
            await persistWorkspaceAssetChanges(captureUserScope());
            expect(peekAssetStoreDraft("owner-a", id)).toBeUndefined();
            useAssetStore.getState().updateAsset(id, { title: "第二版" });
            const second = peekAssetStoreDraft("owner-a", id);
            expect(second?.version).toBe(2);
            ackAssetStoreDraft(captureUserScope(), id, 1);
            expect(peekAssetStoreDraft("owner-a", id)?.version).toBe(2);
        } finally {
            apiClient.defaults.adapter = previous;
            restore();
        }
    });

    test("hydrate keeps an in-flight memory edit over an older durable draft with a larger counter", async () => {
        const restore = switchScope("owner-a");
        const originalWindow = globalThis.window;
        globalThis.window = originalWindow ?? ({ localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } } as never);
        const memory = new Map<string, string>();
        const entered = deferred();
        const gate = deferred();
        const stale = textAsset("asset-1", "旧稿");
        const durable = JSON.stringify({
            drafts: { "asset-1": { kind: "upsert", version: 9, asset: stale } },
            clocks: { "asset-1": 9 },
        });
        const getItem = spyOn(localforage, "getItem").mockImplementation(async (key) => {
            if (isDraftsKey(key)) {
                entered.resolve();
                await gate.promise;
                return durable;
            }
            return memory.get(String(key)) ?? null;
        });
        const setItem = spyOn(localforage, "setItem").mockImplementation(async (key, value) => {
            memory.set(String(key), String(value));
            return value;
        });
        const removeItem = spyOn(localforage, "removeItem").mockImplementation(async (key) => {
            memory.delete(String(key));
        });

        try {
            useAssetStore.setState({ assets: [stale] });
            unloadAssetStoreDraftsForTests();
            const hydrating = hydrateAssetStoreDrafts("owner-a");
            await entered.promise;
            useAssetStore.getState().updateAsset("asset-1", { title: "新稿" });
            expect(peekAssetStoreDraft("owner-a", "asset-1")?.version).toBe(1);
            expect(peekAssetStoreDraft("owner-a", "asset-1")?.asset?.title).toBe("新稿");
            gate.resolve();
            await hydrating;
            expect(useAssetStore.getState().assets.find((item) => item.id === "asset-1")?.title).toBe("新稿");
            const merged = peekAssetStoreDraft("owner-a", "asset-1");
            expect(merged?.asset?.title).toBe("新稿");
            expect(merged?.version).toBeGreaterThan(9);
            ackAssetStoreDraft(captureUserScope(), "asset-1", 9);
            expect(peekAssetStoreDraft("owner-a", "asset-1")?.asset?.title).toBe("新稿");
        } finally {
            gate.resolve();
            getItem.mockRestore();
            setItem.mockRestore();
            removeItem.mockRestore();
            if (!originalWindow) delete (globalThis as { window?: unknown }).window;
            restore();
        }
    });
});
