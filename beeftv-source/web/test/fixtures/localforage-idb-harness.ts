import {
    INFINITE_CANVAS_DB_NAME,
    INFINITE_CANVAS_OBJECT_STORES,
    localForageInstance,
    resetLocalForageDatabaseForTests,
} from "../../src/lib/localforage-storage";

function payload(store: string) {
    return { store, token: "fresh-idb-reopen" };
}

function deleteDatabase(name: string) {
    return new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error ?? new Error(`deleteDatabase ${name} failed`));
    });
}

function openDatabase(name: string, version: number, stores: string[]) {
    return new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name, version);
        request.onupgradeneeded = () => {
            const db = request.result;
            for (const store of stores) {
                if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error(`open ${name} v${version} failed`));
    });
}

Object.assign(window, {
    idbFixture: {
        async wipe() {
            resetLocalForageDatabaseForTests();
            await deleteDatabase(INFINITE_CANVAS_DB_NAME);
        },
        async writeAllConcurrent() {
            resetLocalForageDatabaseForTests();
            const stores = INFINITE_CANVAS_OBJECT_STORES.map((name) => ({ name, store: localForageInstance(name) }));
            const first = await Promise.allSettled(stores.map(({ store, name }) => store.getItem(`probe:${name}`)));
            const firstErrors = first
                .filter((entry): entry is PromiseRejectedResult => entry.status === "rejected")
                .map((entry) => String(entry.reason));
            await Promise.all(stores.map(({ store, name }) => store.setItem(`probe:${name}`, payload(name))));
            await Promise.all(stores.map(async ({ store, name }) => {
                await store.iterate(() => undefined);
                await store.keys();
                await store.length();
            }));
            const written = await Promise.all(stores.map(async ({ store, name }) => [name, await store.getItem(`probe:${name}`)] as const));
            return { firstErrors, written: Object.fromEntries(written) };
        },
        async readAllConcurrent() {
            resetLocalForageDatabaseForTests();
            const stores = INFINITE_CANVAS_OBJECT_STORES.map((name) => ({ name, store: localForageInstance(name) }));
            const values = await Promise.all(stores.map(async ({ store, name }) => [name, await store.getItem(`probe:${name}`)] as const));
            return Object.fromEntries(values);
        },
        async probeVersionchange() {
            const name = "infinite-canvas-versionchange-probe";
            await deleteDatabase(name);
            let handle: IDBDatabase | null = await openDatabase(name, 1, ["app_state"]);
            let sawVersionchange = false;
            const versionchange = new Promise<void>((resolve) => {
                handle!.onversionchange = () => {
                    sawVersionchange = true;
                    handle!.close();
                    handle = null;
                    resolve();
                };
            });
            const upgrade = openDatabase(name, 2, ["app_state", "canvas_folder_pending"]);
            await versionchange;
            let overlappingError = "";
            try {
                handle!.transaction("app_state");
            } catch (error) {
                overlappingError = error instanceof Error ? `${error.name}:${error.message}` : String(error);
            }
            const upgraded = await upgrade;
            const stores = Array.from(upgraded.objectStoreNames);
            upgraded.close();
            await deleteDatabase(name);
            return { sawVersionchange, overlappingError, stores };
        },
    },
});

document.getElementById("status")!.textContent = "ready";
