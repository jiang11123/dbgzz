import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium, type Browser, type Page } from "playwright";

import { CanvasFreeformEmptyState } from "@/components/canvas/canvas-short-drama-entry";

let browser: Browser;
let page: Page;

beforeAll(async () => {
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ headless: true, executablePath });
    page = await browser.newPage({ viewport: { width: 900, height: 600 } });
}, 30_000);

afterAll(async () => {
    await browser?.close();
}, 30_000);

test("the freeform hint lets a double-click reach the canvas without selecting its text", async () => {
    const hint = renderToStaticMarkup(<CanvasFreeformEmptyState commands={[]} />);
    await page.setContent(`
        <style>
            .pointer-events-none { pointer-events: none; }
            .pointer-events-auto { pointer-events: auto; }
            .select-none { user-select: none; }
            .absolute { position: absolute; }
            .relative { position: relative; }
            .inset-0 { inset: 0; }
            .grid { display: grid; }
            .place-items-center { place-items: center; }
            .flex { display: flex; }
            .items-center { align-items: center; }
            .justify-center { justify-content: center; }
            .text-center { text-align: center; }
            .z-20 { z-index: 20; }
            body { margin: 0; }
            #canvas { width: 900px; height: 600px; }
            #empty-state { position: absolute; inset: 0; pointer-events: none; }
        </style>
        <div id="canvas"></div><div id="empty-state">${hint}</div>
    `);
    const label = page.getByText("双击画布", { exact: false });
    const box = await label.boundingBox();
    expect(box).not.toBeNull();
    await page.evaluate(() => {
        (window as Window & { canvasDoubleClicks?: number }).canvasDoubleClicks = 0;
        document.querySelector("#canvas")!.addEventListener("dblclick", () => {
            (window as Window & { canvasDoubleClicks?: number }).canvasDoubleClicks! += 1;
        });
    });
    await page.mouse.dblclick(box!.x + box!.width / 2, box!.y + box!.height / 2);
    expect(await page.evaluate(() => (window as Window & { canvasDoubleClicks?: number }).canvasDoubleClicks)).toBe(1);
    expect(await page.evaluate(() => window.getSelection()?.toString())).not.toContain("双击画布");
    expect(await page.getByRole("button", { name: "关闭连线提示" }).evaluate((button) => getComputedStyle(button).pointerEvents)).toBe("auto");
});
