import { afterEach, describe, expect, spyOn, test } from "bun:test";
import localforage from "localforage";

import { getActiveUserScope, setActiveUserScope } from "@/lib/user-scope";
import { captureUserScope } from "@/lib/user-scope-guard";
import { ASSET_STORE_KEY, flushAssetStorePersistence, hasActiveAssetStorePersistence, resetAssetStoreDraftsForTests, useAssetStore } from "@/stores/use-asset-store";

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

describe("asset store flush namespace isolation", () => {
    afterEach(async () => {
        useAssetStore.setState({ assets: [] });
        await resetAssetStoreDraftsForTests();
    });

    test("A→B→A does not let the abandoned epoch write after the new epoch flush", async () => {
        const restore = switchScope("owner-a");
        const originalWindow = globalThis.window;
        globalThis.window = originalWindow ?? ({ localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } } as never);

        const entered = deferred();
        const gate = deferred();
        const writes: string[] = [];
        let reads = 0;
        const getItem = spyOn(localforage, "getItem").mockImplementation(async () => {
            reads += 1;
            if (reads === 1) {
                entered.resolve();
                await gate.promise;
            }
            return null;
        });
        const setItem = spyOn(localforage, "setItem").mockImplementation(async (key, value) => {
            if (String(key).includes(ASSET_STORE_KEY) && !String(key).includes("asset_store_drafts")) {
                const live = captureUserScope();
                writes.push(`${live.userScope}:${live.epoch}`);
            }
            return value;
        });

        try {
            const firstEpoch = captureUserScope();
            useAssetStore.getState().addAsset({
                kind: "text",
                title: "旧草稿",
                coverUrl: "",
                tags: [],
                category: "other",
                status: "confirmed",
                source: "手动添加",
                data: { content: "old" },
            });
            await entered.promise;
            expect(hasActiveAssetStorePersistence()).toBe(true);
            setActiveUserScope("owner-b");
            setActiveUserScope("owner-a");
            const secondEpoch = captureUserScope();
            expect(secondEpoch.epoch).not.toBe(firstEpoch.epoch);

            useAssetStore.getState().addAsset({
                kind: "text",
                title: "新草稿",
                coverUrl: "",
                tags: [],
                category: "other",
                status: "confirmed",
                source: "手动添加",
                data: { content: "new" },
            });

            const flushing = flushAssetStorePersistence(secondEpoch);
            gate.resolve();
            await flushing;
            expect(hasActiveAssetStorePersistence()).toBe(false);

            expect(writes.some((entry) => entry.endsWith(`:${secondEpoch.epoch}`))).toBe(true);
            expect(writes.some((entry) => entry === `${firstEpoch.userScope}:${firstEpoch.epoch}`)).toBe(false);
        } finally {
            gate.resolve();
            getItem.mockRestore();
            setItem.mockRestore();
            if (!originalWindow) delete (globalThis as { window?: unknown }).window;
            restore();
        }
    });

    test("a failed retained asset queue is not mistaken for ongoing IO", async () => {
        const restore = switchScope("failed-write-test");
        const originalWindow = globalThis.window;
        globalThis.window = originalWindow ?? ({ localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } } as never);
        const getItem = spyOn(localforage, "getItem").mockResolvedValue(null);
        const setItem = spyOn(localforage, "setItem").mockImplementation(async () => { throw new Error("disk write failed"); });
        try {
            useAssetStore.getState().addAsset({ kind: "text", title: "failed", coverUrl: "", tags: [], category: "other", status: "confirmed", source: "manual", data: { content: "keep" } });
            await expect(flushAssetStorePersistence()).rejects.toThrow("disk write failed");
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(hasActiveAssetStorePersistence()).toBe(false);
        } finally {
            getItem.mockRestore(); setItem.mockRestore();
            if (!originalWindow) delete (globalThis as { window?: unknown }).window;
            restore();
        }
    });
});
