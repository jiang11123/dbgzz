import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { existsSync } from "node:fs";

const css = await Bun.file(new URL("../src/styles/globals.css", import.meta.url)).text();

let browser: Browser;
let page: Page;

beforeAll(async () => {
    const executablePath = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ headless: true, executablePath });
    page = await browser.newPage({ viewport: { width: 1280, height: 640 } });
}, 30_000);

afterAll(async () => {
    await browser?.close();
}, 30_000);

test("model picker keeps a viewport-safe frame and scrolls long brand and model lists internally", async () => {
    const brands = Array.from({ length: 12 }, (_, index) => `<button class="canvas-model-picker-brand">渠道 ${index + 1}</button>`).join("");
    const models = Array.from({ length: 20 }, (_, index) => `<button class="canvas-model-picker-option">模型 ${index + 1}</button>`).join("");
    await page.setContent(`
        <style>${css}</style>
        <div class="app-user-workspace">
            <div class="creation-model-picker-surface">
                <div class="canvas-model-picker-menu creation-model-picker-menu is-model-list">
                    <div class="canvas-model-picker-two-pane">
                        <div class="canvas-model-picker-brand-rail">${brands}</div>
                        <section class="canvas-model-picker-group canvas-model-picker-model-pane">
                            <div class="canvas-model-picker-secondary-head">BeefAPI</div>
                            <div class="canvas-model-picker-options">${models}</div>
                        </section>
                    </div>
                </div>
            </div>
        </div>
    `);

    const layout = await page.evaluate(() => {
        const menu = document.querySelector<HTMLElement>(".canvas-model-picker-menu")!;
        const rail = document.querySelector<HTMLElement>(".canvas-model-picker-brand-rail")!;
        const options = document.querySelector<HTMLElement>(".canvas-model-picker-options")!;
        return {
            menuHeight: menu.getBoundingClientRect().height,
            menuOverflowY: getComputedStyle(menu).overflowY,
            railClientHeight: rail.clientHeight,
            railScrollHeight: rail.scrollHeight,
            railOverflowY: getComputedStyle(rail).overflowY,
            optionsClientHeight: options.clientHeight,
            optionsScrollHeight: options.scrollHeight,
            optionsOverflowY: getComputedStyle(options).overflowY,
        };
    });

    expect(layout.menuHeight).toBeLessThanOrEqual(592);
    expect(layout.menuOverflowY).toBe("hidden");
    expect(layout.railOverflowY).toBe("auto");
    expect(layout.railScrollHeight).toBeGreaterThan(layout.railClientHeight);
    expect(layout.optionsOverflowY).toBe("auto");
    expect(layout.optionsScrollHeight).toBeGreaterThan(layout.optionsClientHeight);
});

test("model options keep one aligned name row without secondary copy", async () => {
    await page.setContent(`
        <style>${css}</style>
        <div class="creation-model-picker-surface">
            <div class="canvas-model-picker-menu creation-model-picker-menu is-model-list">
                <button class="canvas-model-picker-option" aria-selected="false">
                    <span class="canvas-model-picker-option-content">
                        <span class="canvas-model-picker-option-name">grok-imagine-video-1.5</span>
                        <span class="canvas-model-picker-description">1-15s · 480P/720P/1080P</span>
                    </span>
                </button>
                <button class="canvas-model-picker-option is-previewed" aria-selected="true">
                    <span class="canvas-model-picker-option-content">
                        <span class="canvas-model-picker-option-name">seedance-2.0-mini</span>
                        <span class="canvas-model-picker-description is-visible">1-15s · 480P/720P/1080P</span>
                    </span>
                </button>
            </div>
        </div>
    `);

    const layout = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>(".canvas-model-picker-option")).map((option) => {
            const name = option.querySelector<HTMLElement>(".canvas-model-picker-option-name")!;
            const content = option.querySelector<HTMLElement>(".canvas-model-picker-option-content")!;
            const description = option.querySelector<HTMLElement>(".canvas-model-picker-description")!;
            const optionRect = option.getBoundingClientRect();
            const nameRect = name.getBoundingClientRect();
            return {
                height: optionRect.height,
                leftInset: Math.round(nameRect.left - optionRect.left),
                verticalOffset: Math.round(nameRect.top + nameRect.height / 2 - (optionRect.top + optionRect.height / 2)),
                contentBackground: getComputedStyle(content).backgroundColor,
                nameBackground: getComputedStyle(name).backgroundColor,
                descriptionDisplay: getComputedStyle(description).display,
            };
        }),
    );

    // Browser transforms can differ by a few millionths of a CSS pixel.
    expect(layout[0]?.height).toBeCloseTo(layout[1]?.height, 2);
    expect(layout[0]?.leftInset).toBe(12);
    expect(layout[1]?.leftInset).toBe(12);
    expect(Math.abs(layout[0]?.verticalOffset || 0)).toBeLessThanOrEqual(1);
    expect(Math.abs(layout[1]?.verticalOffset || 0)).toBeLessThanOrEqual(1);
    expect(layout.map((item) => item.contentBackground)).toEqual(["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)"]);
    expect(layout.map((item) => item.nameBackground)).toEqual(["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)"]);
    expect(layout.every((item) => item.descriptionDisplay === "none")).toBeTrue();
});
