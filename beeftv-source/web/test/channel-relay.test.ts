import { afterEach, expect, test } from "bun:test";

import { channelRequest } from "../src/services/api/custom-channel-relay";
import { MANAGED_BEEFAPI_CREDENTIAL_REF } from "../src/stores/use-config-store";

const originalWindow = globalThis.window;

afterEach(() => {
    if (originalWindow) globalThis.window = originalWindow;
    else Reflect.deleteProperty(globalThis, "window");
});

function stubLocation(location: { protocol: string; hostname?: string }) {
    const wailsWindow = new EventTarget();
    Object.defineProperty(wailsWindow, "location", {
        configurable: true,
        value: { hostname: "", ...location },
    });
    globalThis.window = wailsWindow as Window & typeof globalThis;
}

const ordinaryChannel = {
    baseUrl: "https://api.example.com",
    apiKey: "user-key",
    apiFormat: "openai" as const,
    headers: [{ name: "X-Test", value: "desktop" }],
};

const managedEnterprise = {
    baseUrl: "https://enterprise.beefapi.com",
    apiKey: "",
    apiFormat: "openai" as const,
    credentialRef: MANAGED_BEEFAPI_CREDENTIAL_REF,
};

function expectBackendRelay(request: ReturnType<typeof channelRequest>, upstreamUrl: string, baseUrl: string) {
    expect(request.url).toBe("/api/ai/custom");
    expect(request.credentials).toBe("include");
    expect(request.headers["x-canvas-upstream-url"]).toBe(upstreamUrl);
    expect(request.headers["x-canvas-upstream-base-url"]).toBe(new URL(baseUrl).toString());
}

test("Mac Wails ordinary custom channels call the configured upstream directly", () => {
    stubLocation({ protocol: "wails:" });
    const request = channelRequest(ordinaryChannel, "https://api.example.com/v1/models", { Accept: "application/json" });
    expect(request.url).toBe("https://api.example.com/v1/models");
    expect(request.credentials).toBe("omit");
    expect(request.headers.authorization).toBe("Bearer user-key");
    expect(request.headers["x-test"]).toBe("desktop");
    expect(request.headers["x-canvas-upstream-url"]).toBeUndefined();
});

test("Mac Wails managed enterprise is backend-relayed without a WebView secret", () => {
    stubLocation({ protocol: "wails:" });
    const request = channelRequest(managedEnterprise, "https://enterprise.beefapi.com/v1/models");
    expectBackendRelay(request, "https://enterprise.beefapi.com/v1/models", "https://enterprise.beefapi.com");
    expect(request.headers.authorization).toBe("Bearer");
});

test("Mac Wails enterprise host without credentialRef is still backend-relayed", () => {
    stubLocation({ protocol: "wails:" });
    const request = channelRequest({ baseUrl: "https://enterprise.beefapi.com", apiKey: "", apiFormat: "openai" }, "https://enterprise.beefapi.com/v1/models");
    expectBackendRelay(request, "https://enterprise.beefapi.com/v1/models", "https://enterprise.beefapi.com");
});

test("Windows Wails ordinary custom channels are backend-relayed for CORS", () => {
    stubLocation({ protocol: "http:", hostname: "wails.localhost" });
    const request = channelRequest(ordinaryChannel, "https://api.example.com/v1/models", { Accept: "application/json" });
    expectBackendRelay(request, "https://api.example.com/v1/models", "https://api.example.com");
    expect(request.headers.authorization).toBe("Bearer user-key");
    expect(request.headers["x-test"]).toBeUndefined();
    expect(request.headers["x-canvas-upstream-headers"]).toBeTruthy();
});

test("Windows Wails managed enterprise is backend-relayed without a WebView secret", () => {
    stubLocation({ protocol: "http:", hostname: "wails.localhost" });
    const request = channelRequest(managedEnterprise, "https://enterprise.beefapi.com/v1/models");
    expectBackendRelay(request, "https://enterprise.beefapi.com/v1/models", "https://enterprise.beefapi.com");
    expect(request.headers.authorization).toBe("Bearer");
});

test("lookalike enterprise hosts are not treated as the managed origin", () => {
    stubLocation({ protocol: "wails:" });
    const request = channelRequest(
        {
            baseUrl: "https://enterprise.beefapi.com.attacker.example",
            apiKey: "user-key",
            apiFormat: "openai",
        },
        "https://enterprise.beefapi.com.attacker.example/v1/models",
    );
    expect(request.url).toBe("https://enterprise.beefapi.com.attacker.example/v1/models");
    expect(request.credentials).toBe("omit");
    expect(request.headers["x-canvas-upstream-url"]).toBeUndefined();
    expect(request.headers.authorization).toBe("Bearer user-key");
});
