import { afterEach, beforeEach, expect, test } from "bun:test";
import { apiClient } from "@/services/api/request";
import { confirmDesktopUpdateStartup } from "@/services/desktop-update-startup";
import { useAssetStore } from "@/stores/use-asset-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";

const originalAdapter = apiClient.defaults.adapter;
const assetOptions = useAssetStore.persist.getOptions();
const canvasOptions = useCanvasStore.persist.getOptions();
const originalWindow = globalThis.window;
let confirmed = 0;
let reads: string[] = [];
let failPath = "";

beforeEach(async () => {
    confirmed = 0;
    reads = [];
    failPath = "";
    Object.assign(globalThis, { window: { go: { main: { DesktopApp: { ConfirmUpdateStartup: async () => { confirmed++; } } } } } });
    const storage = { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} };
    useAssetStore.persist.setOptions({ storage });
    useCanvasStore.persist.setOptions({ storage });
    await Promise.all([useAssetStore.persist.rehydrate(), useCanvasStore.persist.rehydrate()]);
    apiClient.defaults.adapter = async (config) => {
        const path = config.url ?? "";
        reads.push(path);
        if (path === failPath) throw new Error("synthetic backend read failure");
        const data = path === "/workspace/bootstrap" ? { profile: "local" } : path === "/assets" ? { assets: [] } : { projects: [] };
        return { status: 200, statusText: "OK", config, headers: {}, data: { code: 0, data } };
    };
});

afterEach(() => {
    apiClient.defaults.adapter = originalAdapter;
    useAssetStore.persist.setOptions(assetOptions);
    useCanvasStore.persist.setOptions(canvasOptions);
    Object.assign(globalThis, { window: originalWindow });
});

test("cleanup requires successful canonical reads even for an empty workspace", async () => {
    expect(await confirmDesktopUpdateStartup()).toBe(true);
    expect(reads.sort()).toEqual(["/assets", "/canvas-projects", "/workspace/bootstrap"]);
    expect(confirmed).toBe(1);
});

for (const store of [useAssetStore, useCanvasStore]) {
    test(`failed ${store === useAssetStore ? "asset" : "canvas"} cache hydration cannot discard recovery files`, async () => {
        store.persist.setOptions({ storage: { getItem: async () => { throw new Error("synthetic cache read failure"); }, setItem: async () => {}, removeItem: async () => {} } });
        await store.persist.rehydrate();
        expect(store.getState().hydrated).toBe(true);
        expect(store.persist.hasHydrated()).toBe(false);
        expect(await confirmDesktopUpdateStartup()).toBe(false);
        expect(confirmed).toBe(0);
        expect(reads).toEqual([]);
    });
}

for (const path of ["/assets", "/canvas-projects", "/workspace/bootstrap"]) {
    test(`a cached UI cannot confirm startup when ${path} fails`, async () => {
        failPath = path;
        await expect(confirmDesktopUpdateStartup()).rejects.toThrow("synthetic backend read failure");
        expect(confirmed).toBe(0);
    });
}

test("browser and old desktop builds do not probe or clean recovery files", async () => {
    Object.assign(globalThis, { window: {} });
    expect(await confirmDesktopUpdateStartup()).toBe(false);
    expect(reads).toEqual([]);
    expect(confirmed).toBe(0);
});
