import { expect, mock, test } from "bun:test";

const calls: string[] = [];
let releaseCache!: () => void;
let applicationReady!: () => void;
let markCacheStarted!: () => void;
const cacheStarted = new Promise<void>((resolve) => { markCacheStarted = resolve; });
const cacheReady = new Promise<void>((resolve) => { releaseCache = resolve; });
const ready = new Promise<void>((resolve) => { applicationReady = resolve; });

mock.module("@fontsource-variable/inter", () => ({}));
mock.module("@fontsource-variable/jetbrains-mono", () => ({}));
mock.module("@/services/diagnostics/browser-environment", () => ({ browserCapabilities: () => ({ secureRandom: true, structuredClone: true, indexedDB: true }) }));
mock.module("@/services/desktop-runtime", () => ({ bootstrapDesktopRuntime: async () => { calls.push("runtime"); } }));
mock.module("@/stores/canvas/use-canvas-store", () => ({
    useCanvasStore: { persist: { rehydrate: async () => { calls.push("cache-start"); markCacheStarted(); await cacheReady; calls.push("cache-end"); } } },
}));
mock.module("@/services/local-workspace-repository", () => ({ hydrateLocalCanvasProjectsFromBackend: async () => { calls.push("backend"); } }));
mock.module("@/services/appearance-bootstrap", () => ({ bootstrapAppearance: async () => { calls.push("appearance"); } }));
mock.module("../src/application", () => { calls.push("application"); applicationReady(); return {}; });

test("startup finishes asynchronous browser cache hydration before backend projection and mounting", async () => {
    await import("../src/main");
    await cacheStarted;
    expect(calls).toEqual(["runtime", "cache-start"]);
    releaseCache();
    await ready;
    expect(calls).toEqual(["runtime", "cache-start", "cache-end", "backend", "appearance", "application"]);
});
