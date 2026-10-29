import { MEDIA_FILES_STORE_NAME, localForageInstance } from "@/lib/localforage-storage";
import { getActiveUserScope } from "@/lib/user-scope";

const store = localForageInstance(MEDIA_FILES_STORE_NAME);
const objectUrls = new Map<string, string>();

/** Local-only media persistence. This module never calls a network or resource API. */
export async function saveLocalMedia(storageKey: string, blob: Blob, previewUrl?: string) {
    await store.setItem(storageKey, blob);
    const url = previewUrl || URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function resolveLocalMediaUrl(storageKey: string, fallback = "") {
    const cached = objectUrls.get(storageKey);
    if (cached) return cached;
    const blob = await store.getItem<Blob>(storageKey);
    if (!blob) return fallback;
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export function getLocalMediaBlob(storageKey: string) {
    return store.getItem<Blob>(storageKey);
}

export async function setLocalMediaBlob(storageKey: string, blob: Blob) {
    return saveLocalMedia(storageKey, blob);
}

export async function deleteLocalMedia(keys: Iterable<string>) {
    await Promise.all(
        Array.from(new Set(keys)).map(async (key) => {
            const url = objectUrls.get(key);
            if (url) URL.revokeObjectURL(url);
            objectUrls.delete(key);
            await store.removeItem(key);
        }),
    );
}

export async function cleanupLocalMedia(usedKeys: Set<string>, scope = getActiveUserScope()) {
    const unused: string[] = [];
    await store.iterate((_value, key) => {
        const parts = key.split(":");
        if (parts.length >= 3 && parts[1] === scope && !usedKeys.has(key)) unused.push(key);
    });
    await Promise.all(unused.map(async (key) => {
        const url = objectUrls.get(key);
        if (url) URL.revokeObjectURL(url);
        objectUrls.delete(key);
        await store.removeItem(key);
    }));
}
