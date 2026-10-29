import { createBrowserRouter, createHashRouter, type RouteObject } from "react-router";

export type AppRoutingLocation = {
    protocol?: string;
    hostname?: string;
    host?: string;
    pathname?: string;
    search?: string;
    hash?: string;
    href?: string;
    origin?: string;
};

export type AppRoutingRuntime = {
    location: AppRoutingLocation;
    desktopApp?: unknown;
    history?: { replaceState: (data: unknown, unused: string, url: string) => void };
};

// 原生 Wails 2.16 把未命中的前端路径交给 desktopAssetHandler，非 /api 即 404；
// 运行时注入只发生在 / 与 index.html。官方路由指南要求 React 使用 hash 路由。
// 浏览器部署继续用 History API，避免把 /api 与媒体地址改成 hash。
export function defaultAppRoutingRuntime(): AppRoutingRuntime {
    if (typeof window === "undefined") {
        return { location: { protocol: "http:", hostname: "localhost", pathname: "/", search: "", hash: "", href: "http://localhost/", origin: "http://localhost" } };
    }
    return {
        location: window.location,
        desktopApp: window.go?.main?.DesktopApp,
        history: window.history,
    };
}

export function usesNativeHashRouting(runtime: AppRoutingRuntime = defaultAppRoutingRuntime()): boolean {
    const protocol = String(runtime.location.protocol || "");
    if (protocol === "wails:") return true;
    const host = String(runtime.location.hostname || runtime.location.host || "");
    if (host === "wails.localhost") return true;
    return runtime.desktopApp != null && typeof runtime.desktopApp === "object";
}

export function workspaceRouterHistoryKind(runtime: AppRoutingRuntime = defaultAppRoutingRuntime()): "hash" | "browser" {
    return usesNativeHashRouting(runtime) ? "hash" : "browser";
}

export function createWorkspaceRouter(routes: RouteObject[], runtime: AppRoutingRuntime = defaultAppRoutingRuntime()) {
    if (workspaceRouterHistoryKind(runtime) === "hash") {
        const rewritten = rewrittenNativeHashHref(runtime);
        if (rewritten) runtime.history?.replaceState(null, "", rewritten);
        return createHashRouter(routes);
    }
    return createBrowserRouter(routes);
}

export function appPathname(runtime: AppRoutingRuntime = defaultAppRoutingRuntime()): string {
    if (usesNativeHashRouting(runtime)) {
        const hash = runtime.location.hash || "";
        if (hash && hash !== "#") return parseHashLocation(hash).pathname;
        return documentPathname(runtime.location.pathname);
    }
    return documentPathname(runtime.location.pathname);
}

export function appSearch(runtime: AppRoutingRuntime = defaultAppRoutingRuntime()): string {
    if (usesNativeHashRouting(runtime)) {
        const hash = runtime.location.hash || "";
        if (hash && hash !== "#") return parseHashLocation(hash).search;
        return runtime.location.search || "";
    }
    return runtime.location.search || "";
}

export function appHref(pathWithSearch: string, runtime: AppRoutingRuntime = defaultAppRoutingRuntime()): string {
    const { pathname, search } = splitAppPath(pathWithSearch);
    if (!usesNativeHashRouting(runtime)) {
        return new URL(`${pathname}${search}`, `${runtimeOrigin(runtime)}/`).toString();
    }
    return nativeDocumentUrl(`${pathname}${search}`, runtime);
}

export function appPathnameFrom(value: string | undefined, runtime: AppRoutingRuntime = defaultAppRoutingRuntime()): string {
    const raw = String(value || "").trim();
    if (!raw) return appPathname(runtime);
    if (raw.startsWith("#")) return parseHashLocation(raw).pathname;
    try {
        const parsed = new URL(raw, `${runtimeOrigin(runtime)}/`);
        if (parsed.hash.startsWith("#/") || (usesNativeHashRouting(runtime) && parsed.hash && parsed.hash !== "#")) {
            return parseHashLocation(parsed.hash).pathname;
        }
        return documentPathname(parsed.pathname);
    } catch {
        return raw.split(/[?#]/u, 1)[0] || "/";
    }
}

export function rewrittenNativeHashHref(runtime: AppRoutingRuntime): string | undefined {
    if (!usesNativeHashRouting(runtime)) return undefined;
    const pathname = runtime.location.pathname || "/";
    if (pathname === "/" || pathname === "/index.html") return undefined;
    if (isAssetOrApiPath(pathname)) return undefined;
    if ((runtime.location.hash || "") && runtime.location.hash !== "#") return undefined;
    return nativeDocumentUrl(`${pathname}${runtime.location.search || ""}`, runtime);
}

export function nativeDocumentUrl(pathWithSearch: string, runtime: AppRoutingRuntime): string {
    const { pathname, search } = splitAppPath(pathWithSearch);
    return `${runtimeOrigin(runtime)}/#${pathname}${search}`;
}

function runtimeOrigin(runtime: AppRoutingRuntime): string {
    const origin = String(runtime.location.origin || "").replace(/\/+$/u, "");
    if (origin && origin !== "null") return origin;
    try {
        if (runtime.location.href) {
            const url = new URL(runtime.location.href);
            if (url.origin !== "null") return url.origin;
            if (url.protocol === "wails:" && url.host) return `${url.protocol}//${url.host}`;
        }
    } catch {
        // href may be a non-standard wails: URL in older webviews
    }
    if (String(runtime.location.protocol || "") === "wails:") return "wails://wails";
    return "http://localhost";
}

function documentPathname(pathname: string | undefined): string {
    const value = pathname || "/";
    return value === "/index.html" ? "/" : value;
}

function splitAppPath(pathWithSearch: string): { pathname: string; search: string } {
    const trimmed = pathWithSearch.trim() || "/";
    const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
    const parsed = new URL(withSlash, "http://app.local");
    return { pathname: parsed.pathname || "/", search: parsed.search || "" };
}

function parseHashLocation(hash: string): { pathname: string; search: string } {
    const raw = hash.startsWith("#") ? hash.slice(1) : hash;
    if (!raw || raw === "/") return { pathname: "/", search: "" };
    return splitAppPath(raw.startsWith("/") ? raw : `/${raw}`);
}

function isAssetOrApiPath(pathname: string): boolean {
    if (pathname === "/api" || pathname.startsWith("/api/")) return true;
    if (pathname.startsWith("/resources/")) return true;
    if (pathname.startsWith("/__desktop/")) return true;
    return /\.[a-z0-9]+$/iu.test(pathname);
}
