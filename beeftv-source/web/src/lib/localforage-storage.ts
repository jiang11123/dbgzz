import localforage from "localforage";
import type { StateStorage } from "zustand/middleware";

import { scopedStorageKey } from "@/lib/user-scope";

export const INFINITE_CANVAS_DB_NAME = "infinite-canvas";
export const APP_STATE_STORE_NAME = "app_state";
export const CANVAS_FOLDER_PENDING_STORE_NAME = "canvas_folder_pending";
export const IMAGE_FILES_STORE_NAME = "image_files";
export const MEDIA_FILES_STORE_NAME = "media_files";
export const RESOURCE_BLOBS_STORE_NAME = "resource_blobs";
export const RESOURCE_BLOB_META_STORE_NAME = "resource_blob_meta";
export const DRAWING_DOCUMENTS_STORE_NAME = "drawing_documents";
export const DRAWING_PREVIEWS_STORE_NAME = "drawing_previews";
export const DRAWING_GENERATION_RENDERS_STORE_NAME = "drawing_generation_renders";

export const INFINITE_CANVAS_OBJECT_STORES = [
    APP_STATE_STORE_NAME,
    CANVAS_FOLDER_PENDING_STORE_NAME,
    IMAGE_FILES_STORE_NAME,
    MEDIA_FILES_STORE_NAME,
    RESOURCE_BLOBS_STORE_NAME,
    RESOURCE_BLOB_META_STORE_NAME,
    DRAWING_DOCUMENTS_STORE_NAME,
    DRAWING_PREVIEWS_STORE_NAME,
    DRAWING_GENERATION_RENDERS_STORE_NAME,
] as const;

localforage.config({
    name: INFINITE_CANVAS_DB_NAME,
    storeName: APP_STATE_STORE_NAME,
});

export type LocalForageKeyStore = {
    getItem<T>(key: string): Promise<T | null>;
    setItem<T>(key: string, value: T): Promise<T>;
    removeItem(key: string): Promise<void>;
    keys(): Promise<string[]>;
    clear(): Promise<void>;
    length(): Promise<number>;
    iterate<T, U>(iteratee: (value: T, key: string, iterationNumber: number) => U): Promise<U>;
};

const stores = new Map<string, LocalForage>();
let databaseReady: Promise<void> | undefined;

// Extra object stores on this IndexedDB name upgrade the whole database and
// close other connections. Open the fixed store list once, sequentially, then
// let ordinary get/set/iterate overlap so a stalled cache read cannot block
// a durable draft write. ready() errors propagate and clear this barrier so
// the next caller retries init; a missing driver is not an opened database.

function createDefaultStore(storeName: string): LocalForage {
    return storeName === APP_STATE_STORE_NAME
        ? localforage
        : localforage.createInstance({ name: INFINITE_CANVAS_DB_NAME, storeName });
}

let storeFactory = createDefaultStore;

function forageForStore(storeName: string): LocalForage {
    const cached = stores.get(storeName);
    if (cached) return cached;
    const instance = storeFactory(storeName);
    stores.set(storeName, instance);
    return instance;
}

async function openInfiniteCanvasStores() {
    for (const storeName of INFINITE_CANVAS_OBJECT_STORES) {
        await forageForStore(storeName).ready();
    }
}

function ensureInfiniteCanvasDatabase(): Promise<void> {
    if (!databaseReady) {
        databaseReady = openInfiniteCanvasStores().then(
            () => undefined,
            (error) => {
                stores.clear();
                databaseReady = undefined;
                throw error;
            },
        );
    }
    return databaseReady;
}

async function withStore<T>(storeName: string, job: (store: LocalForage) => Promise<T>): Promise<T> {
    await ensureInfiniteCanvasDatabase();
    return job(forageForStore(storeName));
}

export function localForageInstance(storeName: string): LocalForageKeyStore {
    return {
        getItem: <T>(key: string) => withStore(storeName, (store) => store.getItem<T>(key)),
        setItem: <T>(key: string, value: T) => withStore(storeName, (store) => store.setItem(key, value)),
        removeItem: (key: string) => withStore(storeName, (store) => store.removeItem(key)),
        keys: () => withStore(storeName, (store) => store.keys()),
        clear: () => withStore(storeName, (store) => store.clear()),
        length: () => withStore(storeName, (store) => store.length()),
        iterate: <T, U>(iteratee: (value: T, key: string, iterationNumber: number) => U) =>
            withStore(storeName, (store) => store.iterate(iteratee)),
    };
}

export function localForageStorageForScope(scope?: string): StateStorage {
    const keyFor = (name: string) => scopedStorageKey(name, scope);
    const store = localForageInstance(APP_STATE_STORE_NAME);
    return {
        getItem: async (name) => {
            if (typeof window === "undefined") return null;
            return (await store.getItem<string>(keyFor(name))) || null;
        },
        setItem: async (name, value) => {
            if (typeof window === "undefined") return;
            await store.setItem(keyFor(name), value);
        },
        removeItem: async (name) => {
            if (typeof window === "undefined") return;
            await store.removeItem(keyFor(name));
        },
    };
}

export const localForageStorage: StateStorage = localForageStorageForScope();

export function resetLocalForageDatabaseForTests() {
    stores.clear();
    databaseReady = undefined;
}

export function installLocalForageStoreFactoryForTests(factory?: (storeName: string) => LocalForage) {
    storeFactory = factory ?? createDefaultStore;
    resetLocalForageDatabaseForTests();
}
