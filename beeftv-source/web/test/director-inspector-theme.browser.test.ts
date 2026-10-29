import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";
import { existsSync } from "node:fs";

let browser: Browser;
const source = await Bun.file(import.meta.dir + "/../src/styles/globals.css").text();
const styles = source.replace(/^@import .*$/gm, "");

beforeAll(async () => {
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ headless: true, executablePath });
});
afterAll(async () => { await browser?.close(); });

for (const dark of [false, true]) for (const width of [1280, 620]) {
    test(`角色检查器在${dark ? "深" : "浅"}色 ${width}px 下保持文字对比度与姿势网格`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        try {
            await page.setContent(`<html class="${dark ? "dark" : ""}"><style>
                ${styles}
                *, *::before, *::after { transition: none !important; animation: none !important; }
                body { background: var(--background); color: var(--cn-text); } input { background: transparent; color: inherit; } aside { width: min(100%, 320px); }
                </style><aside class="director-actor-inspector">
                <header>角色</header><input aria-label="名称" value="标准男性 1">
                <div class="director-actor-axis-input"><input value="0.0"></div>
                <div class="director-actor-hex-input"><input value="438CDB"></div>
                <section class="director-pose-section"><div class="director-pose-grid">${Array.from({ length: 20 }, (_, i) => `<button class="director-pose-button ${i === 0 ? "is-active" : ""}">姿势</button>`).join("")}</div></section>
                <div class="director-pose-adjust-header"><div>姿势调节</div></div>
                <div class="director-pose-controls"><h4>身体</h4><div class="director-bone-axis-row"><span>X</span><div></div><div class="ant-input-number"><input class="ant-input-number-input" value="0.0"></div></div></div>
                </aside>`);
            const contrasts = await page.evaluate(() => {
                function pixel(color: string) {
                    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
                    const context = canvas.getContext("2d")!;
                    context.fillStyle = color; context.fillRect(0, 0, 1, 1);
                    return Array.from(context.getImageData(0, 0, 1, 1).data);
                }
                function luminance(rgb: number[]) {
                    const linear = rgb.slice(0, 3).map((v) => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; });
                    return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
                }
                return Array.from(document.querySelectorAll("input, .director-pose-button, .director-pose-adjust-header > div, h4, .director-bone-axis-row > span")).map((element) => {
                    let background = pixel(getComputedStyle(document.body).backgroundColor);
                    const ancestors: Element[] = [];
                    for (let node: Element | null = element; node && node !== document.body; node = node.parentElement) ancestors.unshift(node);
                    for (const node of ancestors) {
                        const fill = pixel(getComputedStyle(node).backgroundColor);
                        background = background.map((v, i) => i < 3 ? fill[i] * fill[3] / 255 + v * (1 - fill[3] / 255) : 255);
                    }
                    const color = pixel(getComputedStyle(element).color);
                    const foreground = color.map((v, i) => i < 3 ? v * color[3] / 255 + background[i] * (1 - color[3] / 255) : 255);
                    const a = luminance(foreground), b = luminance(background);
                    return { target: element.outerHTML.slice(0, 100), color: getComputedStyle(element).color, fills: ancestors.map((el) => [el.className, getComputedStyle(el).backgroundColor]), background, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
                });
            });
            for (const contrast of contrasts) expect(contrast.ratio, JSON.stringify(contrast)).toBeGreaterThanOrEqual(4.5);
            expect(await page.locator(".director-pose-button").count()).toBe(20);
            expect(await page.locator("aside").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        } finally { await page.close(); }
    });
}
