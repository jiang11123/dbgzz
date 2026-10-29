import { afterEach, expect, test } from "bun:test";

import { apiBaseURL, apiClient } from "@/services/api/request";
import { bootstrapDesktopRuntime, configureDesktopRuntime, getDesktopUpdateBinding } from "@/services/desktop-runtime";

const originalFetch = globalThis.fetch;

test("Electron updates use the preload bridge without enabling the Wails API bootstrap", async () => {
    const bridge = {
        UpdateStatus: async () => ({ status: "idle" as const, currentVersion: "3.0.0", latestVersion: "", releaseNotes: "", downloadedBytes: 0, totalBytes: 0, bytesPerSecond: 0, reconnecting: false, error: "" }),
        CheckForUpdate: async () => bridge.UpdateStatus(),
        DownloadUpdate: async () => bridge.UpdateStatus(),
        InstallUpdate: async () => {},
    };
    Object.assign(globalThis, { window: { location: { protocol: "http:" }, doubaoUpdater: bridge } });
    expect(getDesktopUpdateBinding()).toBe(bridge);
    expect(await bootstrapDesktopRuntime()).toBe(false);
    expect((await getDesktopUpdateBinding()!.UpdateStatus!()).currentVersion).toBe("3.0.0");
});

afterEach(() => {
    globalThis.fetch = originalFetch;
});

test("desktop runtime configures axios and same-runtime fetches without persisting the token", async () => {
    let captured: Request | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        captured = new Request(input, init);
        return new Response(null, { status: 204 });
    }) as typeof fetch;

    configureDesktopRuntime({ baseURL: "http://127.0.0.1:43123/api", launchToken: "ephemeral-token", uiBootstrapToken: "ui-only-token" });

    expect(apiBaseURL).toBe("http://127.0.0.1:43123/api");
    expect(apiClient.defaults.baseURL).toBe("http://127.0.0.1:43123/api");
    expect(apiClient.defaults.headers.common["X-Desktop-Token"]).toBe("ephemeral-token");
    expect(apiClient.defaults.headers.common["X-Beeftv-UI-Bootstrap"]).toBe("ui-only-token");

    await fetch("http://127.0.0.1:43123/api/tasks", { headers: { Accept: "application/json" } });
    expect(captured?.headers.get("X-Desktop-Token")).toBe("ephemeral-token");
    expect(captured?.headers.get("Accept")).toBe("application/json");
    expect(captured?.headers.get("X-Beeftv-UI-Bootstrap")).toBeNull();
});

test("desktop bootstrap obtains ephemeral runtime configuration from the Wails binding", async () => {
    Object.assign(globalThis, {
        window: {
            go: {
                main: {
                    DesktopApp: {
                        RuntimeConfig: async () => ({ baseURL: "http://127.0.0.1:43124/api", launchToken: "binding-token" }),
                    },
                },
            },
        },
    });

    expect(await bootstrapDesktopRuntime()).toBe(true);
    expect(apiBaseURL).toBe("http://127.0.0.1:43124/api");
});

test("desktop bootstrap falls back to the Wails asset handler when binding startup races", async () => {
    Object.assign(globalThis, {
        window: {
            location: { protocol: "wails:" },
            go: { main: { DesktopApp: { RuntimeConfig: async () => Promise.reject(new Error("binding not ready")) } } },
        },
    });
    globalThis.fetch = (async () =>
        new Response(JSON.stringify({ baseURL: "http://127.0.0.1:43125/api", launchToken: "handler-token" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        })) as typeof fetch;

    expect(await bootstrapDesktopRuntime()).toBe(true);
    expect(apiBaseURL).toBe("http://127.0.0.1:43125/api");
});

test("desktop bootstrap rejects an empty early binding result and uses the asset handler", async () => {
    Object.assign(globalThis, {
        window: {
            location: { protocol: "wails:" },
            go: { main: { DesktopApp: { RuntimeConfig: async () => ({ baseURL: "", launchToken: "" }) } } },
        },
    });
    globalThis.fetch = (async () =>
        new Response(JSON.stringify({ baseURL: "http://127.0.0.1:43126/api", launchToken: "handler-token" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        })) as typeof fetch;

    expect(await bootstrapDesktopRuntime()).toBe(true);
    expect(apiBaseURL).toBe("http://127.0.0.1:43126/api");
});
