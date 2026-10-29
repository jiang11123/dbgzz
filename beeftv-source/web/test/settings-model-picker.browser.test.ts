import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { productCss } from "./fixtures/product-css";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

type DiagnosticEvent = { code?: string; message: string; level: string };

beforeAll(async () => {
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/settings-model-picker-harness.tsx"], target: "browser", define: { "import.meta.env.DEV": "false", "import.meta.env.PROD": "true", "import.meta.env.MODE": '"production"', "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"true"', "import.meta.env.VITE_CANVAS_BACKEND_URL": '"/api"', "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "source", setup(builder) {
        // Vite owns icon glob expansion; this harness only covers settings interactions.
        builder.onResolve({ filter: /^@\/components\/model-logo$/ }, () => ({ path: "model-logo", namespace: "test-icons" }));
        builder.onLoad({ filter: /.*/, namespace: "test-icons" }, () => ({ contents: "export function ModelLogo() { return null; }", loader: "js" }));
        builder.onResolve({ filter: /^@\// }, args => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
    } }] });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const js = await build.outputs.find(o => o.path.endsWith(".js"))!.text();
    const css = (await build.outputs.find(o => o.path.endsWith(".css"))?.text() || "")
        + await productCss();
    server = Bun.serve({ port: 0, fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/harness.js") return new Response(js, { headers: { "Content-Type": "application/javascript" } });
        if (path === "/harness.css") return new Response(css, { headers: { "Content-Type": "text/css" } });
        if (path.includes("model-config")) return Response.json({ code: 0, data: req.method === "GET" ? { config: {}, revision: 0 } : { saved: true, revision: 1 } });
        if (path.startsWith("/api/")) return Response.json({ code: 0, data: {} });
        const dark = new URL(req.url).searchParams.get("theme") === "dark";
        return new Response(`<html class="${dark ? "dark" : ""}"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/harness.css"><body class="app-product-overlays"><div id="root" class="app-product-workspace"></div><script type="module" src="/harness.js"></script></body></html>`, { headers: { "Content-Type": "text/html" } });
    } });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p): p is string => Boolean(p && existsSync(p)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 120000);
afterAll(async () => { await browser?.close(); server?.stop(true); }, 30000);

async function open(options: { reduced?: boolean; dark?: boolean; mobile?: boolean } = {}): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: options.mobile ? 390 : 1424, height: 921 }, reducedMotion: options.reduced ? "reduce" : "no-preference" });
    await page.goto(server.url.toString() + (options.dark ? "?theme=dark" : ""));
    await page.getByRole("button", { name: "删除渠道 工作室渠道" }).waitFor();
    return page;
}

const events = (page: Page) => page.evaluate(() => (window as unknown as { diagnostics: () => DiagnosticEvent[] }).diagnostics());

async function openOverlayPicker(page: Page, surface: "侧栏" | "弹窗") {
    await page.getByRole("button", { name: `打开验证${surface}` }).click();
    const kind = surface === "侧栏" ? "drawer" : "modal";
    await page.locator(`[data-testid="overlay-motion-state"][data-${kind}-settled="true"]`).waitFor({ state: "attached" });
    const select = page.locator(`.ant-${kind} .model-default-select`).first();
    await select.click();
    const popup = page.locator(".model-default-select-popup-image:not(.ant-select-dropdown-hidden)");
    await popup.waitFor();
    return { select, popup };
}

async function readSettledPicker(page: Page, select: Locator, popup: Locator) {
    // The fixture has background and overlay pickers with the same diagnostic ID.
    // Measure these exact elements, without using the global diagnostic event.
    const elements = { trigger: (await select.elementHandle())!, popup: (await popup.elementHandle())! };
    return await page.evaluate(async ({ trigger, popup }) => {
        const read = () => {
            if (/(?:appear|enter|leave)(?:-|$)/.test(popup.getAttribute("class") || "")
                || popup.getAnimations().some(animation => animation.playState === "running")
                || getComputedStyle(popup).opacity !== "1") return null;
            const triggerRect = trigger.getBoundingClientRect();
            const popupRect = popup.getBoundingClientRect();
            return {
                triggerBox: { x: triggerRect.x, y: triggerRect.y, width: triggerRect.width, height: triggerRect.height },
                popupBox: { x: popupRect.x, y: popupRect.y, width: popupRect.width, height: popupRect.height },
                placement: { transform: popup.style.transform, left: popup.style.left, top: popup.style.top },
            };
        };
        const deadline = performance.now() + 3000;
        let previous = "";
        let stableFrames = 0;
        while (performance.now() < deadline) {
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
            const geometry = read();
            const signature = geometry ? JSON.stringify(geometry) : "";
            stableFrames = signature && signature === previous ? stableFrames + 1 : 0;
            previous = signature;
            // Wait for stable geometry, not correct geometry: a settled offset must fail.
            if (geometry && stableFrames >= 2) return geometry;
        }
        throw new Error("Picker layout did not settle");
    }, elements);
}

function expectPickerAttached({ triggerBox, popupBox }: Awaited<ReturnType<typeof readSettledPicker>>) {
    expect(Math.abs(popupBox.y - triggerBox.y - triggerBox.height)).toBeLessThanOrEqual(8);
    expect(Math.abs(popupBox.x - triggerBox.x)).toBeLessThanOrEqual(8);
}

test("菜单在窗口外时诊断报告不可见，保留动效偏好", async () => {
    const page = await open({ reduced: true });
    try {
        await page.addStyleTag({ content: ".model-default-select-popup { left: -20000px !important; top: -20000px !important; }" });
        await page.locator('section[aria-labelledby="default-text-title"] .model-default-select').click();
        await page.waitForFunction(() => (window as unknown as { diagnostics: () => DiagnosticEvent[] }).diagnostics().some(event => event.code === "MODEL_PICKER_POPUP_HIDDEN"), undefined, { timeout: 3000 });
        const recorded = await events(page);
        const hidden = recorded.find(event => event.code === "MODEL_PICKER_POPUP_HIDDEN")!;
        expect(hidden.level).toBe("warning");
        expect(hidden.message).toContain("在窗口外");
        expect(hidden.message).toContain("无法检测遮挡");
        expect(hidden.message).toContain("减少动态效果 开启");
        expect(recorded.some(event => event.code === "MODEL_PICKER_OPEN")).toBe(false);
    } finally { await page.close(); }
}, 30000);

test("高分屏默认模型菜单紧贴自己的选择框", async () => {
    const page = await open({ reduced: true });
    try {
        await page.setViewportSize({ width: 2560, height: 1440 });
        await page.evaluate(() => document.body.classList.add("app-user-overlays"));
        const select = page.locator(".model-default-select").first();
        await select.click();
        const popup = page.locator(".model-default-select-popup-image:not(.ant-select-dropdown-hidden)");
        await popup.waitFor();
        await page.waitForFunction(() => (window as unknown as { diagnostics: () => DiagnosticEvent[] }).diagnostics().some(event => event.code === "MODEL_PICKER_OPEN"));
        const triggerBox = (await select.boundingBox())!;
        const popupBox = (await popup.boundingBox())!;
        expect(Math.abs(popupBox.y - triggerBox.y - triggerBox.height)).toBeLessThanOrEqual(8);
        if (process.env.BEEFTV_SETTINGS_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.BEEFTV_SETTINGS_SCREENSHOT_DIR}/default-model-highdpi.png` });
    } finally { await page.close(); }
}, 15000);

for (const [surface, cpuRate] of [["侧栏", 1], ["弹窗", 1], ["弹窗", 4]] as const) {
    test(`减少动态效果下，${surface}里的菜单保持贴合选择框${cpuRate > 1 ? "（4 倍 CPU 降速）" : ""}`, async () => {
        const page = await open({ reduced: true });
        try {
            if (cpuRate > 1) {
                const session = await page.context().newCDPSession(page);
                await session.send("Emulation.setCPUThrottlingRate", { rate: cpuRate });
            }
            const { select, popup } = await openOverlayPicker(page, surface);
            const geometry = await readSettledPicker(page, select, popup);
            expectPickerAttached(geometry);
            // Inspect the placement mechanism instead of assuming transform
            // carries translation in this pinned Ant Design version.
            const { placement } = geometry;
            expect(placement.transform).not.toContain("translate");
            expect(parseFloat(placement.left)).toBeGreaterThan(0);
            expect(parseFloat(placement.top)).toBeGreaterThan(0);
        } finally { await page.close(); }
    }, 15000);
}

test("动效结束后故意偏移的弹窗菜单仍不通过贴合断言", async () => {
    const page = await open({ reduced: true });
    try {
        const { select, popup } = await openOverlayPicker(page, "弹窗");
        await page.addStyleTag({ content: ".model-default-select-popup { top: 700px !important; }" });
        const geometry = await readSettledPicker(page, select, popup);
        expect(geometry.popupBox.y).toBe(700);
        expect(() => expectPickerAttached(geometry)).toThrow();
    } finally { await page.close(); }
}, 15000);

test("菜单仍在窗口内但偏离选择框时单独告警", async () => {
    const page = await open({ reduced: true });
    try {
        await page.addStyleTag({ content: ".model-default-select-popup { top: 700px !important; }" });
        await page.locator(".model-default-select").first().click();
        await page.waitForFunction(() => (window as unknown as { diagnostics: () => DiagnosticEvent[] }).diagnostics().some(event => event.code === "MODEL_PICKER_POPUP_MISALIGNED"));
        const event = (await events(page)).find(event => event.code === "MODEL_PICKER_POPUP_MISALIGNED")!;
        expect(event.level).toBe("warning");
        expect(event.message).toContain("在窗口内");
        expect(event.message).toContain("菜单位置偏离选择框");
    } finally { await page.close(); }
}, 15000);

for (const dark of [false, true]) {
    test(`模型能力标签有可读的文字与底色：${dark ? "深色" : "浅色"}`, async () => {
        const page = await open({ dark });
        try {
            await page.getByRole("button", { name: "查看模型能力标签" }).click();
            const tag = page.locator(".ant-tag").first();
            const contrast = await tag.evaluate(element => {
                const style = getComputedStyle(element);
                const context = document.createElement("canvas").getContext("2d")!;
                const parse = (color: string) => {
                    context.clearRect(0, 0, 1, 1);
                    context.fillStyle = color;
                    context.fillRect(0, 0, 1, 1);
                    const rgba = [...context.getImageData(0, 0, 1, 1).data];
                    return [rgba[0]!, rgba[1]!, rgba[2]!, rgba[3]! / 255];
                };
                const surface = parse(getComputedStyle(document.body).backgroundColor);
                const blend = (rgba: number[]) => rgba.slice(0, 3).map((value, i) => value * (rgba[3] ?? 1) + surface[i]! * (1 - (rgba[3] ?? 1)));
                const luminance = (rgb: number[]) => rgb.map(value => { const c = value / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; }).reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i]!, 0);
                const foreground = luminance(blend(parse(style.color)));
                const background = luminance(blend(parse(style.backgroundColor)));
                return (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05);
            });
            expect(contrast).toBeGreaterThanOrEqual(4.5);
            if (process.env.BEEFTV_SETTINGS_SCREENSHOT_DIR) await page.getByTestId("model-capabilities").screenshot({ path: `${process.env.BEEFTV_SETTINGS_SCREENSHOT_DIR}/model-tags-${dark ? "dark" : "light"}.png` });
        } finally { await page.close(); }
    }, 15000);
}

test("快速切换模型时诊断只检查最后打开的菜单", async () => {
    const page = await open({ reduced: true });
    try {
        await page.locator('section[aria-labelledby="default-image-title"] .model-default-select').click();
        await page.locator('section[aria-labelledby="default-text-title"] .model-default-select').click();
        await page.waitForFunction(() => (window as unknown as { diagnostics: () => DiagnosticEvent[] }).diagnostics().some(event => event.code === "MODEL_PICKER_OPEN" && event.message.startsWith("默认文本模型")), undefined, { timeout: 3000 });
        const opened = (await events(page)).filter(event => event.code === "MODEL_PICKER_OPEN" || event.code === "MODEL_PICKER_POPUP_HIDDEN");
        expect(opened).toHaveLength(1);
        expect(opened[0]!.message).toContain("默认文本模型");
        expect(opened[0]!.message).toContain("在窗口内");
        const recorded = await events(page);
        expect(recorded.some(event => event.code === "MODEL_PICKER_CLOSE" && event.message.startsWith("默认生图模型"))).toBe(true);
        expect(recorded.some(event => event.code === "MODEL_PICKER_POPUP_HIDDEN")).toBe(false);
    } finally { await page.close(); }
}, 30000);

for (const reduced of [false, true]) {
    for (const dark of [false, true]) {
        for (const mobile of [false, true]) {
            test(`删除渠道确认可见并可点击：${reduced ? "减少动态效果" : "普通动效"} / ${dark ? "深色" : "浅色"} / ${mobile ? "手机" : "桌面"}`, async () => {
                const page = await open({ reduced, dark, mobile });
                const screenshotBase = process.env.BEEFTV_SETTINGS_SCREENSHOT_DIR && `${process.env.BEEFTV_SETTINGS_SCREENSHOT_DIR}/delete-${reduced ? "reduced" : "normal"}-${dark ? "dark" : "light"}-${mobile ? "mobile" : "desktop"}`;
                try {
                    const trigger = page.getByRole("button", { name: "删除渠道 工作室渠道" });
                    if (screenshotBase) await page.screenshot({ path: `${screenshotBase}-before.png` });
                    await trigger.click();
                    const ok = page.locator(".ant-popconfirm button").filter({ hasText: /^删\s?除$/ });
                    await ok.waitFor();
                    // The popconfirm is visible before its enter motion accepts pointer events.
                    // Wait for hit testing, then use an actual pointer click at the button centre.
                    const handle = await ok.elementHandle();
                    await page.waitForFunction((button: Element) => {
                        const box = button.getBoundingClientRect();
                        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
                        return hit === button || button.contains(hit);
                    }, handle, { timeout: 3000 });
                    const viewport = page.viewportSize()!;
                    const checkedBounds = async () => {
                        const box = (await ok.boundingBox())!;
                        const popupBox = (await page.locator(".ant-popconfirm").boundingBox())!;
                        expect(popupBox.x).toBeGreaterThanOrEqual(0);
                        expect(popupBox.y).toBeGreaterThanOrEqual(0);
                        expect(popupBox.x + popupBox.width).toBeLessThanOrEqual(viewport.width + 1);
                        expect(popupBox.y + popupBox.height).toBeLessThanOrEqual(viewport.height + 1);
                        expect(box.x).toBeGreaterThanOrEqual(0);
                        expect(box.y).toBeGreaterThanOrEqual(0);
                        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
                        expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
                        return box;
                    };
                    // Hit testing can pass before enter motion starts. Preserve the
                    // off-screen check before trial can scroll, then wait for stability.
                    await checkedBounds();
                    await ok.click({ trial: true, timeout: 3000 });
                    if (screenshotBase) await page.screenshot({ path: `${screenshotBase}-confirm.png` });
                    const box = await checkedBounds();
                    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
                    await page.getByTestId("channel-count").filter({ hasText: /^0$/ }).waitFor({ timeout: 3000 });
                    await page.waitForFunction(() => (window as unknown as { diagnostics: () => DiagnosticEvent[] }).diagnostics().some(event => event.code === "CHANNEL_DELETED"), undefined, { timeout: 3000 });
                    const codes = (await events(page)).map(event => event.code);
                    expect(codes).toContain("CHANNEL_DELETE_CONFIRM_OPEN");
                    expect(codes).toContain("CHANNEL_DELETED");
                    if (screenshotBase) await page.screenshot({ path: `${screenshotBase}-after.png` });
                } catch (error) {
                    if (screenshotBase) {
                        await page.screenshot({ path: `${screenshotBase}-failure.png` });
                        console.error(await page.locator(".ant-popconfirm").evaluateAll(elements => elements.map(element => {
                            const rect = element.getBoundingClientRect();
                            const style = getComputedStyle(element);
                            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, opacity: style.opacity, transform: style.transform, transitionProperty: style.transitionProperty };
                        })));
                    }
                    throw error;
                } finally { await page.close(); }
            }, 30000);
        }
    }
}

test("默认模型下拉展开时诊断记录点击、弹层位置与遮挡情况", async () => {
    const page = await open();
    try {
        await page.locator('section[aria-labelledby="default-text-title"] .model-default-select').click();
        await page.locator(".model-default-select-popup .ant-select-item-option").first().waitFor();
        await page.waitForFunction(() => (window as unknown as { diagnostics: () => DiagnosticEvent[] }).diagnostics().some(event => event.code === "MODEL_PICKER_OPEN" || event.code === "MODEL_PICKER_POPUP_HIDDEN"), undefined, { timeout: 3000 });
        const recorded = await events(page);
        expect(recorded.some(event => event.code === "MODEL_PICKER_PRESS" && event.message.includes("默认文本模型"))).toBe(true);
        const opened = recorded.find(event => event.code === "MODEL_PICKER_OPEN")!;
        expect(opened.message).toContain("未被遮挡");
        expect(opened.message).toContain("已渲染选项 3 个");
        expect(opened.message).toContain("在窗口内");
    } finally { await page.close(); }
}, 30000);

for (const reduced of [false, true]) {
    test(`产品侧栏和弹窗关闭后移除遮罩：${reduced ? "减少动态效果" : "普通动效"}`, async () => {
        const page = await open({ reduced });
        try {
            const initialOverflow = await page.evaluate(() => getComputedStyle(document.body).overflow);
            await page.getByRole("button", { name: "打开验证侧栏", exact: true }).click();
            await page.getByRole("button", { name: "关闭验证侧栏", exact: true }).click();
            await page.locator(".ant-drawer").waitFor({ state: "detached", timeout: 3000 });
            await page.getByRole("button", { name: "打开验证弹窗", exact: true }).click();
            await page.getByRole("button", { name: "关闭验证弹窗", exact: true }).click();
            await page.locator(".ant-modal-root").waitFor({ state: "detached", timeout: 3000 });
            expect(await page.evaluate(() => document.querySelectorAll(".ant-drawer-mask, .ant-modal-mask").length)).toBe(0);
            expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).toBe(initialOverflow);
        } finally { await page.close(); }
    }, 30000);
    for (const dark of [false, true]) {
        for (const mobile of [false, true]) {
            test(`六类默认模型可见并可选择：${reduced ? "减少动态效果" : "普通动效"} / ${dark ? "深色" : "浅色"} / ${mobile ? "手机" : "桌面"}`, async () => {
                const page = await open({ reduced, dark, mobile });
                try {
                    for (const [id, key, model] of [
                        ["image", "imageModel", "image-z"],
                        ["video", "videoModel", "video-z"],
                        ["text", "textModel", "chat-z"],
                        ["assistant", "assistantModel", "chat-z"],
                        ["multimodal", "mediaReviewModel", "wand-vega-vl-1.0-flash"],
                        ["audio", "audioModel", "audio-z"],
                    ]) {
                        const row = page.locator(`section[aria-labelledby="default-${id}-title"]`);
                        const title = await row.locator("h3").textContent();
                        await row.locator(".model-default-select").click();
                        await page.waitForFunction((title) => (window as unknown as { diagnostics: () => DiagnosticEvent[] }).diagnostics().some(event => event.code === "MODEL_PICKER_OPEN" && event.message.startsWith(title!)), title, { timeout: 3000 });
                        const popup = page.locator(".model-default-select-popup:not(.ant-select-dropdown-hidden)");
                        const box = (await popup.boundingBox())!;
                        const trigger = (await row.locator(".model-default-select").boundingBox())!;
                        expect(Math.min(Math.abs(box.y - trigger.y - trigger.height), Math.abs(trigger.y - box.y - box.height))).toBeLessThanOrEqual(8);
                        const viewport = page.viewportSize()!;
                        expect(box.x).toBeGreaterThanOrEqual(0);
                        expect(box.y).toBeGreaterThanOrEqual(0);
                        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
                        expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
                        if (process.env.BEEFTV_MODEL_PICKER_SCREENSHOT && reduced && !dark && !mobile && id === "text") {
                            await page.screenshot({ path: process.env.BEEFTV_MODEL_PICKER_SCREENSHOT });
                        }
                        await popup.locator(".ant-select-item-option").filter({ hasText: model! }).click();
                        const selected = JSON.parse((await page.getByTestId("selected-models").textContent())!);
                        expect(selected[key!]).toBe(`studio::${model}`);
                    }
                    const recorded = await events(page);
                    expect(recorded.filter(event => event.code === "MODEL_PICKER_CHANGE")).toHaveLength(6);
                    expect(recorded.filter(event => event.code === "MODEL_PICKER_POPUP_HIDDEN")).toHaveLength(0);
                    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
                } finally { await page.close(); }
            }, 30000);
        }
    }
}

test("盖在下拉上的浮层接走点击时，诊断记下是谁挡住了", async () => {
    const page = await open();
    try {
        const select = page.locator(".model-default-select").first();
        const box = (await select.boundingBox())!;
        await page.evaluate(() => {
            const layer = document.createElement("div");
            layer.className = "ant-modal-mask";
            Object.assign(layer.style, { position: "fixed", inset: "0", zIndex: "2000" });
            document.body.appendChild(layer);
        });
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        const blocked = (await events(page)).find(event => event.code === "MODEL_PICKER_BLOCKED");
        expect(blocked?.message).toContain("div.ant-modal-mask");
    } finally { await page.close(); }
}, 30000);
