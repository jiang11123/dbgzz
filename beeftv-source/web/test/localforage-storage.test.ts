import { afterEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import localforage from "localforage";

import {
    APP_STATE_STORE_NAME,
    INFINITE_CANVAS_OBJECT_STORES,
    installLocalForageStoreFactoryForTests,
    localForageInstance,
    localForageStorageForScope,
    resetLocalForageDatabaseForTests,
} from "@/lib/localforage-storage";

afterEach(() => {
    installLocalForageStoreFactoryForTests();
});

const wiredModules: Array<[string, string[]]> = [
    ["lib/canvas/canvas-folder-storage.ts", ["localForageInstance(CANVAS_FOLDER_PENDING_STORE_NAME)"]],
    ["lib/canvas/canvas-drawing-storage.ts", [
        "localForageInstance(DRAWING_DOCUMENTS_STORE_NAME)",
        "localForageInstance(DRAWING_PREVIEWS_STORE_NAME)",
        "localForageInstance(DRAWING_GENERATION_RENDERS_STORE_NAME)",
    ]],
    ["services/image-storage.ts", ["localForageInstance(IMAGE_FILES_STORE_NAME)"]],
    ["services/local-media-repository.ts", ["localForageInstance(MEDIA_FILES_STORE_NAME)"]],
    ["services/resource-blob-cache.ts", [
        "localForageInstance(RESOURCE_BLOBS_STORE_NAME)",
        "localForageInstance(RESOURCE_BLOB_META_STORE_NAME)",
    ]],
];

test("infinite-canvas stores use the shared facade instead of a private createInstance", () => {
    for (const [relative, wirings] of wiredModules) {
        const source = readFileSync(resolve(import.meta.dir, "../src", relative), "utf8");
        for (const wiring of wirings) expect(source).toContain(wiring);
        expect(source).not.toContain("localforage.createInstance");
        expect(source).not.toContain("from \"localforage\"");
    }
    const facade = readFileSync(resolve(import.meta.dir, "../src/lib/localforage-storage.ts"), "utf8");
    for (const storeName of INFINITE_CANVAS_OBJECT_STORES) {
        expect(facade).toContain(`"${storeName}"`);
    }
    expect(facade).not.toContain("No available storage method found.");
    expect(facade).not.toContain("isUnavailableDriverError");
    expect(facade).not.toContain("typeof instance.ready");
});

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function memoryStore(storeName: string, options: {
    ready?: () => Promise<void>;
    jobs?: string[];
    values?: Map<string, unknown>;
    stallGet?: { match: (key: string) => boolean; entered: { resolve: () => void }; gate: Promise<void> };
} = {}) {
    const values = options.values ?? new Map<string, unknown>();
    return {
        ready: options.ready ?? (async () => undefined),
        getItem: async (key: string) => {
            if (options.stallGet?.match(key)) {
                options.stallGet.entered.resolve();
                await options.stallGet.gate;
            }
            options.jobs?.push(`get:${storeName}:${key}`);
            return values.get(key) ?? null;
        },
        setItem: async (key: string, value: unknown) => {
            options.jobs?.push(`set:${storeName}:${key}`);
            values.set(key, value);
            return value;
        },
        removeItem: async (key: string) => {
            options.jobs?.push(`remove:${storeName}:${key}`);
            values.delete(key);
        },
        keys: async () => [...values.keys()].map(String),
        clear: async () => { values.clear(); },
        length: async () => values.size,
        iterate: async (iteratee: (value: unknown, key: string, iterationNumber: number) => unknown) => {
            let index = 1;
            for (const [key, value] of values) {
                const result = iteratee(value, String(key), index);
                index += 1;
                if (result !== undefined) return result;
            }
            return undefined;
        },
    } as LocalForage;
}

test("first open readies object stores one at a time", async () => {
    let inflight = 0;
    let overlapped = false;
    const readied: string[] = [];
    const mark = async (storeName: string) => {
        if (inflight) overlapped = true;
        inflight += 1;
        readied.push(storeName);
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (inflight > 1) overlapped = true;
        inflight -= 1;
    };
    const ready = spyOn(localforage, "ready").mockImplementation(async () => {
        await mark(APP_STATE_STORE_NAME);
    });
    const getItem = spyOn(localforage, "getItem").mockResolvedValue(null);
    const createInstance = spyOn(localforage, "createInstance").mockImplementation((options: { storeName?: string } = {}) => {
        const storeName = options.storeName || "";
        return {
            ready: async () => mark(storeName),
            getItem: async () => null,
            setItem: async (_key: string, value: unknown) => value,
            removeItem: async () => undefined,
            keys: async () => [],
            clear: async () => undefined,
            length: async () => 0,
            iterate: async () => undefined,
        } as never;
    });
    try {
        await Promise.all(INFINITE_CANVAS_OBJECT_STORES.map((name) => localForageInstance(name).getItem("probe")));
        expect(overlapped).toBe(false);
        expect(readied).toEqual([...INFINITE_CANVAS_OBJECT_STORES]);
        expect(createInstance.mock.calls.map((call) => call[0]?.storeName)).toEqual(
            INFINITE_CANVAS_OBJECT_STORES.filter((name) => name !== APP_STATE_STORE_NAME),
        );
    } finally {
        ready.mockRestore();
        getItem.mockRestore();
        createInstance.mockRestore();
        resetLocalForageDatabaseForTests();
    }
});

test("init failure rejects pending read/write without executing jobs", async () => {
    const jobs: string[] = [];
    installLocalForageStoreFactoryForTests((storeName) => memoryStore(storeName, {
        jobs,
        ready: async () => {
            throw new Error("No available storage method found.");
        },
    }));
    const read = localForageInstance(APP_STATE_STORE_NAME).getItem("cache");
    const write = localForageInstance(APP_STATE_STORE_NAME).setItem("drafts", "edited");
    const results = await Promise.allSettled([read, write]);
    expect(results).toEqual([
        { status: "rejected", reason: expect.objectContaining({ message: "No available storage method found." }) },
        { status: "rejected", reason: expect.objectContaining({ message: "No available storage method found." }) },
    ]);
    expect(jobs).toEqual([]);
});

test("after init failure the next call retries init successfully", async () => {
    const jobs: string[] = [];
    let initFails = true;
    installLocalForageStoreFactoryForTests((storeName) => memoryStore(storeName, {
        jobs,
        ready: async () => {
            if (initFails) throw new Error("No available storage method found.");
        },
    }));
    await expect(localForageInstance(APP_STATE_STORE_NAME).getItem("cache")).rejects.toThrow("No available storage method found.");
    expect(jobs).toEqual([]);
    initFails = false;
    await localForageInstance(APP_STATE_STORE_NAME).setItem("drafts", "edited");
    expect(jobs).toEqual(["set:app_state:drafts"]);
});

test("stalled app_state cache getItem does not block a draft setItem", async () => {
    const originalWindow = globalThis.window;
    globalThis.window = originalWindow ?? ({ localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } } as never);
    const entered = deferred();
    const gate = deferred();
    const values = new Map<string, unknown>();
    installLocalForageStoreFactoryForTests((storeName) => memoryStore(storeName, {
        values: storeName === APP_STATE_STORE_NAME ? values : undefined,
        stallGet: storeName === APP_STATE_STORE_NAME
            ? {
                match: (key) => key.includes("asset_store") && !key.includes("asset_store_drafts"),
                entered,
                gate: gate.promise,
            }
            : undefined,
    }));
    try {
        const storage = localForageStorageForScope("owner-a");
        const read = storage.getItem("infinite-canvas:asset_store");
        await entered.promise;
        await storage.setItem("infinite-canvas:asset_store_drafts", JSON.stringify({ drafts: { asset: { title: "编辑后" } } }));
        expect([...values.entries()].some(([key, value]) => String(key).includes("asset_store_drafts") && String(value).includes("编辑后"))).toBe(true);
        gate.resolve();
        await read;
    } finally {
        gate.resolve();
        if (!originalWindow) delete (globalThis as { window?: unknown }).window;
        else globalThis.window = originalWindow;
        resetLocalForageDatabaseForTests();
    }
});
