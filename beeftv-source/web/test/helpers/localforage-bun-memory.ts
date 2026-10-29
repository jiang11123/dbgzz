import localforage from "localforage";

export const BUN_MEMORY_DRIVER = "beeftvBunMemoryStorage";

type Store = Map<string, unknown>;
type Callback<T> = (error: unknown, value?: T) => void;
const databases = new Map<string, Map<string, Store>>();
const instances = new WeakMap<LocalForage, Store>();

function operation<T>(instance: LocalForage, callback: Callback<T> | undefined, job: (store: Store) => T): Promise<T> {
    const promise = instance.ready().then(() => job(instances.get(instance)!));
    if (typeof callback === "function") promise.then(value => callback(null, value), error => callback(error));
    return promise;
}

const memoryDriver = {
    _driver: BUN_MEMORY_DRIVER,
    _support: true,
    async _initStorage(this: LocalForage, options: LocalForageOptions) {
        const name = options.name!;
        const storeName = options.storeName!;
        let database = databases.get(name);
        if (!database) databases.set(name, database = new Map());
        let store = database.get(storeName);
        if (!store) database.set(storeName, store = new Map());
        instances.set(this, store);
    },
    getItem<T>(this: LocalForage, key: string, callback?: Callback<T | null>) {
        return operation(this, callback, store => structuredClone((store.get(String(key)) ?? null) as T | null));
    },
    setItem<T>(this: LocalForage, key: string, value: T, callback?: Callback<T | null>) {
        return operation(this, callback, store => {
            const normalized = value === undefined ? null : value;
            store.set(String(key), structuredClone(normalized));
            return normalized;
        });
    },
    removeItem(this: LocalForage, key: string, callback?: Callback<void>) {
        return operation(this, callback, store => { store.delete(String(key)); });
    },
    clear(this: LocalForage, callback?: Callback<void>) {
        return operation(this, callback, store => { store.clear(); });
    },
    length(this: LocalForage, callback?: Callback<number>) {
        return operation(this, callback, store => store.size);
    },
    key(this: LocalForage, index: number, callback?: Callback<string | null>) {
        return operation(this, callback, store => [...store.keys()][index] ?? null);
    },
    keys(this: LocalForage, callback?: Callback<string[]>) {
        return operation(this, callback, store => [...store.keys()]);
    },
    iterate<T, U>(this: LocalForage, iteratee: (value: T, key: string, iterationNumber: number) => U, callback?: Callback<U | undefined>) {
        return operation(this, callback, store => {
            let index = 1;
            for (const [key, value] of store) {
                const result = iteratee(structuredClone(value) as T, key, index++);
                if (result !== undefined) return result;
            }
            return undefined;
        });
    },
};

// Register a complete driver so ready() keeps localforage's real initialization
// and rejection behavior. The published typings omit the documented null returns.
await localforage.defineDriver(memoryDriver as LocalForageDriver);
await localforage.setDriver(BUN_MEMORY_DRIVER);
const createInstance = localforage.createInstance.bind(localforage);
localforage.createInstance = (options: LocalForageOptions = {}) => createInstance(
    options.driver === undefined ? { ...options, driver: BUN_MEMORY_DRIVER } : options,
);
