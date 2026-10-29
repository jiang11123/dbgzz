import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { appChangelogZh } from "../src/components/layout/app-changelog.zh";

const root = resolve(import.meta.dir, "..");

function read(path: string) {
    return readFileSync(resolve(root, path), "utf8");
}

describe("desktop update UI contract", () => {
    test("installed release has published notes in both the release and in-app changelogs", () => {
        const version = read("../VERSION").trim();
        expect(read("../CHANGELOG.md")).toContain(`## ${version}\n`);
        expect(appChangelogZh.find((entry) => entry.version === version)?.changes.length).toBeGreaterThan(0);
        expect(new Set(appChangelogZh.map((entry) => entry.version)).size).toBe(appChangelogZh.length);
    });
    test("sidebar version area is desktop-gated and keeps changelog access", () => {
        const sidebar = read("src/components/layout/workspace-sidebar-nav.tsx");
        const update = read("src/components/layout/workspace-sidebar-update.tsx");
        const changelog = read("src/components/layout/app-changelog-modal.tsx");
        const account = read("src/components/layout/workspace-account-menu.tsx");
        const shell = read("src/components/layout/app-top-nav.tsx");

        expect(sidebar).toContain("WorkspaceSidebarUpdate");
        expect(sidebar).toContain("app-workspace-sidebar-footer");
        expect(account).toContain("AppChangelogButton");
        expect(account).toContain("showVersion");
        expect(changelog).toContain("查看更新日志");
        expect(shell).toContain("useDesktopUpdateBootstrap");
        expect(update).toContain("AppChangelogButton");
        expect(update).toContain("showVersion");
        expect(update).toContain("updater.downloadAndInstall()");
        expect(update).toContain("AppModal");
        expect(update).toContain("仍然更新");
        expect(update).toContain("尚未保存的修改可能丢失");
        expect(update).toContain("updater.check()");
        expect(update).toContain('aria-live="polite"');
        expect(update).toContain("desktopUpdateDetailLabel");
        expect(update).toContain("hasResumableDesktopUpdate");
        expect(update).toContain('role="progressbar"');
        expect(update).toContain("useReducedMotion");
        expect(update).not.toContain("Modal.confirm");
        expect(update).not.toContain("所有修改已保存");
        expect(update).not.toContain("github.com");
        expect(update).not.toContain("desktop-update.json");
        expect(update).not.toContain("Wails");
        expect(update).not.toContain("BeefAPI");
    });

    test("frontend update client never fetches a release origin", () => {
        const service = read("src/services/desktop-update.ts");
        const hook = read("src/hooks/use-desktop-update.ts");
        const runtime = read("src/services/desktop-runtime.ts");
        for (const source of [service, hook, runtime]) {
            expect(source).not.toContain("github.com");
            expect(source).not.toContain("desktop-update.json");
        }
        expect(service).not.toContain("fetch(");
        expect(hook).not.toContain("fetch(");
        expect(service).toContain("CheckForUpdate");
        expect(service).toContain("DownloadUpdate");
        expect(service).toContain("InstallUpdate");
        expect(hook).toContain("DESKTOP_UPDATE_CHECK_INTERVAL_MS");
        expect(hook).toContain("controller.check()");
        expect(service).toContain("flushCanvasStorePersistence");
        expect(runtime).toContain("UpdateStatus");
        expect(runtime).toContain("currentVersion");
        expect(runtime).toContain("downloadedBytes");
    });

    test("installed version stays visible when updater controls are hidden", () => {
        const update = read("src/components/layout/workspace-sidebar-update.tsx");
        expect(update).toContain("showVersion");
        expect(update).toContain("shouldShowDesktopUpdaterControls");
        expect(update).toContain("currentVersion");
        expect(update.indexOf("AppChangelogButton")).toBeLessThan(update.indexOf("showControls"));
    });
});
