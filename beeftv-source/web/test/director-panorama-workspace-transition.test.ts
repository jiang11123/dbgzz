import { expect, spyOn, test } from "bun:test";
import localforage from "localforage";
import { applyUserSession } from "../src/lib/user-session";
import { getActiveUserScope, setActiveUserScope } from "../src/lib/user-scope";
import { generateDirectorPanorama } from "../src/lib/canvas/director/director-panorama-generation";
import { defaultConfig } from "../src/stores/use-config-store";
import type { GenerationTask } from "../src/services/api/task-center";

test("workspace hydration aborts and drains a panorama materializer before switching stores", async () => {
    const previousScope = getActiveUserScope();
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const values = new Map([["infinite-canvas:active-user-scope", "owner-a"]]);
    Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
        removeItem: (key: string) => { values.delete(key); },
    } } });
    setActiveUserScope("owner-a");
    const get = spyOn(localforage, "getItem").mockResolvedValue(null);
    const set = spyOn(localforage, "setItem").mockImplementation(async (_key, value) => value);
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const materializing = new Promise<void>((resolve) => { entered = resolve; });
    const writes: string[] = [];
    let materializerSignal: AbortSignal | undefined;
    const task = { id: "task-1", status: "succeeded", outputs: [] } as unknown as GenerationTask;
    try {
        const generation = generateDirectorPanorama({ file: new File(["test"], "reference.png", { type: "image/png" }), config: defaultConfig, sceneId: "scene-1", projectId: "project-1" }, {
            selectModel: () => "image-model",
            upload: async () => ({ url: "blob:source", storageKey: "source", width: 800, height: 400, bytes: 4, mimeType: "image/png" }),
            submit: async () => task, wait: async () => task,
            materialize: async (value, signal) => {
                materializerSignal = signal;
                entered();
                await paused;
                // The real asset materializer checks this immediately before committing.
                signal?.throwIfAborted();
                writes.push(getActiveUserScope());
                return value;
            },
            findAsset: () => undefined, updateAsset: () => { writes.push(getActiveUserScope()); },
        }).catch((error: unknown) => error);
        await materializing;
        const transition = applyUserSession({
            contractVersion: 1, profile: "local", capabilities: { localAssets: true, providerCalls: true },
            user: { id: "owner-b", username: "local", displayName: "本地工作区", role: "user", status: "active", createdAt: "", updatedAt: "" },
            workspace: { id: "owner-b", name: "本地工作区", owner: "local", storage: "sqlite" }, storageMode: "local",
        });
        await Promise.resolve();
        expect(materializerSignal?.aborted).toBe(true);
        expect(getActiveUserScope()).toBe("owner-a");
        release();
        expect((await generation as Error).name).toBe("AbortError");
        await transition;
        expect(getActiveUserScope()).toBe("owner-b");
        expect(writes).toEqual([]);
    } finally {
        release();
        get.mockRestore(); set.mockRestore();
        if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
        else Reflect.deleteProperty(globalThis, "window");
        setActiveUserScope(previousScope);
    }
});
