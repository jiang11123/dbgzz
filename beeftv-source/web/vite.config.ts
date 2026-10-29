import { dirname, resolve } from "node:path";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import { resolveHeavyMediaEnabled } from "./media-build-mode";
import { distributionNotices } from "../scripts/distribution-notices.mjs";

const webDir = dirname(fileURLToPath(import.meta.url));
const appVersion = process.env.CANVAS_BUILD_VERSION?.trim() || readFileSync(resolve(webDir, "../VERSION"), "utf8").trim();
const buildCommit = (() => {
    const configured = process.env.VITE_BUILD_COMMIT?.trim();
    if (configured && /^[a-f0-9]{7,40}$/i.test(configured)) return configured;
    try { return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: webDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
    catch { return "unknown"; }
})();
const apiProxyTarget = process.env.VITE_API_PROXY_TARGET?.trim() || "http://127.0.0.1:8080";
const desktopLaunchToken = process.env.VITE_DESKTOP_LAUNCH_TOKEN?.trim();
const heavyMediaEnabled = resolveHeavyMediaEnabled(process.env.BEEFTV_FULL_MEDIA_RESOURCES);

function pruneOptionalMediaPlugin() {
    return {
        name: "beeftv-prune-optional-media",
        closeBundle() {
            const dist = resolve(webDir, "dist");
            // The retired public welcome site is never part of the application.
            rmSync(resolve(dist, "welcome"), { recursive: true, force: true });
            if (heavyMediaEnabled) return;
            for (const directory of ["mediapipe", "lighting-presets", "three"]) {
                rmSync(resolve(dist, directory), { recursive: true, force: true });
            }
            rmSync(resolve(dist, "canvas/models/blaze-face-full-range-sparse.tflite"), { force: true });
            const staticDir = resolve(dist, "static");
            for (const file of readdirSync(staticDir)) {
                if (file.startsWith("ffmpeg-core-")) rmSync(resolve(staticDir, file), { force: true });
            }
        },
    };
}

function licenseNoticesPlugin(): Plugin {
    const notices = () => distributionNotices({ version: appVersion, heavyMedia: heavyMediaEnabled, platform: process.env.BEEFTV_DIST_PLATFORM || "web" });
    return {
        name: "beeftv-license-notices",
        configureServer(server) {
            server.middlewares.use((request, response, next) => {
                const name = request.url?.split("?")[0]?.replace(/^\/licenses\//, "");
                if (!request.url?.startsWith("/licenses/") || !name) return next();
                const bytes = notices().get(name);
                if (!bytes) {
                    response.statusCode = 404;
                    response.end("Not found");
                    return;
                }
                response.setHeader("Content-Type", name.endsWith(".html") ? "text/html; charset=utf-8" : "text/plain; charset=utf-8");
                response.end(bytes);
            });
        },
        generateBundle() {
            for (const [name, source] of notices()) {
                this.emitFile({ type: "asset", fileName: `licenses/${name}`, source });
            }
        },
    };
}

export default defineConfig({
    plugins: [react(), pruneOptionalMediaPlugin(), licenseNoticesPlugin()],
    define: {
        __APP_VERSION__: JSON.stringify(appVersion),
        __BEEFTV_HEAVY_MEDIA_ENABLED__: JSON.stringify(heavyMediaEnabled),
        "import.meta.env.VITE_APP_VERSION": JSON.stringify(appVersion),
        "import.meta.env.VITE_BUILD_COMMIT": JSON.stringify(buildCommit),
    },
    server: {
        proxy: {
            "/api": {
                target: apiProxyTarget,
                changeOrigin: true,
                xfwd: true,
                ...(desktopLaunchToken ? { headers: { "X-Desktop-Token": desktopLaunchToken } } : {}),
            },
        },
    },
    resolve: {
        alias: {
            "@": resolve(webDir, "src"),
        },
    },
    build: {
        // Keep the SPA route `/assets` distinct from Vite's emitted static files.
        // Otherwise vite preview treats `/assets` as the physical asset directory
        // and a direct refresh of the asset library can return 404.
        assetsDir: "static",
        rolldownOptions: {
            output: {
                strictExecutionOrder: true,
                codeSplitting: {
                    // Keep route-level lazy imports isolated. Recursively merging dependencies
                    // pulls unrelated pages into the initial modulepreload graph.
                    includeDependenciesRecursively: false,
                    minSize: 40 * 1024,
                    groups: [
                        {
                            // Shared interop helpers must not be emitted into a route entry:
                            // AntD would import that entry back and execute its bootstrap early.
                            name: "vendor-babel-runtime",
                            minSize: 0,
                            test: /node_modules[\\/]@babel[\\/]runtime[\\/]/,
                            priority: 40,
                        },
                        {
                            name: "vendor-react",
                            test: /node_modules[\\/](?:react(?:-dom|-router|-router-dom)?|scheduler|zustand|use-sync-external-store|@tanstack[\\/](?:query-core|react-query))[\\/]/,
                            priority: 30,
                        },
                        {
                            name: "vendor-icons",
                            test: /node_modules[\\/](?:lucide-react|@ant-design[\\/]icons)[\\/]/,
                            priority: 20,
                            entriesAware: true,
                            entriesAwareMergeThreshold: 48 * 1024,
                        },
                        {
                            name: "vendor-antd",
                            test: /node_modules[\\/](?:antd|@ant-design|@rc-component|rc-[^\\/]+|dayjs)[\\/]/,
                            priority: 10,
                            entriesAware: true,
                            entriesAwareMergeThreshold: 80 * 1024,
                        },
                    ],
                },
            },
        },
    },
});
