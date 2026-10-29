import { describe, expect, test } from "bun:test";

import {
    appHref,
    appPathname,
    appPathnameFrom,
    appSearch,
    rewrittenNativeHashHref,
    usesNativeHashRouting,
    workspaceRouterHistoryKind,
    type AppRoutingRuntime,
} from "@/lib/app-routing";

function browser(pathname = "/canvas/abc", search = ""): AppRoutingRuntime {
    return {
        location: {
            protocol: "https:",
            hostname: "app.example",
            pathname,
            search,
            hash: "",
            href: `https://app.example${pathname}${search}`,
            origin: "https://app.example",
        },
    };
}

function nativeWails(hash = "#/canvas/abc", search = ""): AppRoutingRuntime {
    return {
        location: {
            protocol: "wails:",
            hostname: "wails",
            pathname: "/",
            search: "",
            hash,
            href: `wails://wails/${hash}`,
            origin: new URL("wails://wails/").origin,
        },
    };
}

function nativeWindows(hash = "#/canvas/abc"): AppRoutingRuntime {
    return {
        location: {
            protocol: "http:",
            hostname: "wails.localhost",
            host: "wails.localhost",
            pathname: "/",
            search: "",
            hash,
            href: `http://wails.localhost/${hash}`,
            origin: "http://wails.localhost",
        },
    };
}

function nativeBinding(pathname = "/", hash = ""): AppRoutingRuntime {
    return {
        location: {
            protocol: "http:",
            hostname: "127.0.0.1",
            pathname,
            search: "",
            hash,
            href: `http://127.0.0.1:3000${pathname}${hash}`,
            origin: "http://127.0.0.1:3000",
        },
        desktopApp: { RuntimeConfig: () => Promise.resolve({}) },
    };
}

describe("native hash routing detection", () => {
    test("browser keeps history routing", () => {
        expect(usesNativeHashRouting(browser())).toBe(false);
        expect(workspaceRouterHistoryKind(browser())).toBe("browser");
    });

    test("wails: protocol uses hash routing", () => {
        expect(workspaceRouterHistoryKind(nativeWails())).toBe("hash");
    });

    test("Windows wails.localhost and DesktopApp binding use hash routing", () => {
        expect(workspaceRouterHistoryKind(nativeWindows())).toBe("hash");
        expect(workspaceRouterHistoryKind(nativeBinding())).toBe("hash");
    });
});

describe("route URL contract", () => {
    test("browser canvas href stays on the document path", () => {
        const href = appHref("/canvas/abc", browser("/"));
        const url = new URL(href);
        expect(url.pathname).toBe("/canvas/abc");
        expect(url.hash).toBe("");
        expect(appPathname(browser("/canvas/abc"))).toBe("/canvas/abc");
    });

    test("native canvas href reloads index.html, not the deep path", () => {
        const mac = appHref("/canvas/abc", nativeWails("#"));
        expect(mac).toBe("wails://wails/#/canvas/abc");
        const macUrl = new URL(mac);
        expect(macUrl.pathname === "/" || macUrl.pathname === "").toBe(true);
        expect(macUrl.hash).toBe("#/canvas/abc");

        const win = new URL(appHref("/canvas/abc", nativeWindows("#")));
        expect(win.origin).toBe("http://wails.localhost");
        expect(win.pathname).toBe("/");
        expect(win.hash).toBe("#/canvas/abc");
        expect(appPathname(nativeWindows("#/canvas/abc"))).toBe("/canvas/abc");
        expect(appPathname(nativeWails("#/canvas/abc?note=1"))).toBe("/canvas/abc");
        expect(appSearch(nativeWails("#/canvas/abc?note=1"))).toBe("?note=1");
    });

    test("leftover native path URLs rewrite to hash before the router starts", () => {
        const leftover = nativeBinding("/canvas/abc");
        expect(rewrittenNativeHashHref(leftover)).toBe("http://127.0.0.1:3000/#/canvas/abc");
        expect(rewrittenNativeHashHref(nativeBinding("/api/health"))).toBeUndefined();
        expect(rewrittenNativeHashHref(nativeBinding("/assets/index.js"))).toBeUndefined();
        expect(rewrittenNativeHashHref(browser("/canvas/abc"))).toBeUndefined();
    });

    test("API and media URLs stay on the document origin path", () => {
        const nativeHref = appHref("/canvas/abc", nativeWindows("#"));
        const api = new URL("/api/resources/res-1/file", nativeHref);
        expect(api.pathname).toBe("/api/resources/res-1/file");
        expect(api.hash).toBe("");
        expect(api.origin).toBe("http://wails.localhost");
        const browserMedia = new URL("/api/resources/res-1/file", appHref("/canvas/abc", browser("/")));
        expect(browserMedia.pathname).toBe("/api/resources/res-1/file");
        expect(browserMedia.hash).toBe("");
    });

    test("diagnostics and preload read the hash route on native", () => {
        expect(appPathnameFrom(undefined, nativeWails("#/canvas/abc"))).toBe("/canvas/abc");
        expect(appPathnameFrom("http://wails.localhost/#/canvas/abc", nativeWindows("#/canvas/abc"))).toBe("/canvas/abc");
        expect(appPathnameFrom("/canvas/abc", browser("/canvas/abc"))).toBe("/canvas/abc");
        expect(appPathnameFrom("https://app.example/canvas/abc", browser("/canvas/abc"))).toBe("/canvas/abc");
        expect(appHref("/settings?section=channels", nativeWindows("#"))).toBe("http://wails.localhost/#/settings?section=channels");
        expect(new URL(appHref("/settings?section=channels", browser("/"))).pathname).toBe("/settings");
    });
});
