import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";

const globalsCss = await Bun.file(new URL("../src/styles/globals.css", import.meta.url)).text();
const workspaceCss = await Bun.file(new URL("../src/styles/workspace-product.css", import.meta.url)).text();
const homeCss = await Bun.file(new URL("../src/pages/home/home-dashboard.css", import.meta.url)).text();

let browser: Browser;
let page: Page;

beforeAll(async () => {
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ headless: true, executablePath });
    page = await browser.newPage();
}, 30_000);

afterAll(async () => {
    await browser?.close();
}, 30_000);

async function readPalette({ dark, home, width = 1440 }: { dark: boolean; home: boolean; width?: number }) {
    await page.setViewportSize({ width, height: 900 });
    await page.setContent(`
        <html class="${dark ? "dark" : ""}"><head><style>${globalsCss}\n${workspaceCss}\n${homeCss}</style></head>
        <body><div class="app-user-workspace app-product-workspace ${home ? "app-home-route" : ""}">
            <div class="app-workspace-shell">
                <aside class="app-workspace-sidebar"><div class="app-workspace-sidebar-nav"></div><div class="app-workspace-sidebar-footer"></div></aside>
                <div class="app-workspace-stage"><main class="beeftv-home">
                    <div class="beeftv-home-hero"></div><div class="beeftv-capability-icon"></div><div class="beeftv-recent-card"></div>
                    <div class="project-library-card"></div><div class="libtv-create-project-card"></div><div class="libtv-folder-card-cover"></div>
                    <div class="assets-library-page"><div class="canvas-library-frame"></div><div class="workspace-expandable-search-input"></div></div>
                    <div class="settings-page"><div class="settings-library-frame"><div class="settings-channel"></div></div></div>
                </main></div>
            </div>
        </div></body></html>
    `);
    return page.evaluate(() => {
        const background = (selector: string) => getComputedStyle(document.querySelector(selector)!).backgroundColor;
        return {
            stage: background(".app-workspace-stage"),
            sidebar: background(".app-workspace-sidebar"),
            sidebarNav: background(".app-workspace-sidebar-nav"),
            sidebarFooter: background(".app-workspace-sidebar-footer"),
            hero: background(".beeftv-home-hero"),
            capability: background(".beeftv-capability-icon"),
            recent: background(".beeftv-recent-card"),
            projectCard: background(".project-library-card"),
            projectCreateCard: background(".libtv-create-project-card"),
            assetFrame: background(".assets-library-page .canvas-library-frame"),
            modelFrame: background(".settings-library-frame"),
            modelChannel: background(".settings-channel"),
        };
    });
}

test("dark workspace keeps home, projects, assets and model settings on one near-black palette", async () => {
    const expected = {
        stage: "rgb(16, 16, 16)",
        sidebar: "rgb(22, 22, 22)",
        sidebarNav: "rgb(22, 22, 22)",
        sidebarFooter: "rgb(22, 22, 22)",
        hero: "rgb(32, 32, 32)",
        capability: "rgb(32, 32, 32)",
        recent: "rgb(22, 22, 22)",
        projectCard: "rgb(23, 23, 23)",
        projectCreateCard: "rgb(32, 32, 32)",
        assetFrame: "rgb(22, 22, 22)",
        modelFrame: "rgb(22, 22, 22)",
        modelChannel: "rgb(22, 22, 22)",
    };
    for (const width of [1440, 840]) {
        expect(await readPalette({ dark: true, home: true, width })).toEqual(expected);
        expect(await readPalette({ dark: true, home: false, width })).toEqual(expected);
    }
    const lightHome = await readPalette({ dark: false, home: true });
    expect(lightHome.stage).toBe("rgb(248, 248, 250)");
});

test("dark project folder and asset search do not keep the brighter gray fills", async () => {
    await readPalette({ dark: true, home: false });
    const colors = await page.evaluate(() => ({
        folder: getComputedStyle(document.querySelector(".libtv-folder-card-cover")!).backgroundImage,
        search: getComputedStyle(document.querySelector(".workspace-expandable-search-input")!).backgroundColor,
    }));
    const folderTop = colors.folder.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    expect(folderTop).not.toBeNull();
    expect(Number(folderTop![1])).toBeLessThanOrEqual(48);
    expect(colors.search).toBe("rgb(32, 32, 32)");
});
