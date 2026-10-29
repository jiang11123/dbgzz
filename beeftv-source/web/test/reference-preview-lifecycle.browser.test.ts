import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser;
let page: Page;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
    const build = await Bun.build({
        entrypoints: [import.meta.dir + "/fixtures/reference-preview-harness.tsx"], target: "browser", format: "esm",
        define: { "import.meta.env": "{}", "process.env.NODE_ENV": '"production"' },
        plugins: [{ name: "preview-io", setup(builder) {
            // This fixture supplies references directly; avoid booting the
            // unrelated registry of generation editors and provider adapters.
            builder.onResolve({ filter: /^@\/lib\/canvas\/node-registry$/ }, () => ({ path: Bun.resolveSync("../src/lib/canvas/node-registry/node-registry.ts", import.meta.dir) }));
            builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
            builder.onLoad({ filter: /src\/lib\/video-poster\.ts$/ }, () => ({ loader: "js", contents: `
                export async function detectVideoAudioTrackFromBlob() { return undefined; }
                export function detectVideoAudioTrack() { return undefined; }
                export async function detectVideoAudioTrackFromUrl() { return undefined; }
                export async function capturePresentedVideoPoster() { throw new Error('unexpected presented capture'); }
                export async function captureVideoPoster(url, {signal}) {
                    window.captures.push(url);
                    if (url.startsWith('slow')) await new Promise(resolve => window.pending.set(url, resolve));
                    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
                    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jO1sAAAAASUVORK5CYII='), c => c.charCodeAt(0));
                    return {poster: new Blob([bytes], {type:'image/png'}), width:40, height:30, capturedAtMs:0};
                }` }));
            builder.onLoad({ filter: /src\/services\/canvas-video-source\.ts$/ }, () => ({ loader: "js", contents: `export async function acquireCanvasVideoSource(key, content) { return {url: content || key, release() {}}; }` }));
            builder.onLoad({ filter: /src\/services\/image-storage\.ts$/ }, () => ({ loader: "js", contents: `
                export async function resolveImageUrl(key) { return 'data:image/png,' + key; }
                const unexpected = () => { throw new Error('unexpected image storage operation'); };
                export {unexpected as uploadImage, unexpected as getImageBlob, unexpected as setImageBlob, unexpected as imageToDataUrl, unexpected as deleteStoredImages, unexpected as cleanupUnusedImages, unexpected as collectImageStorageKeys};` }));
            builder.onLoad({ filter: /src\/lib\/canvas\/canvas-drawing-storage\.ts$/ }, () => ({ loader: "js", contents: `export async function loadCanvasDrawingPreview() { return null; }` }));
            builder.onLoad({ filter: /src\/hooks\/use-personal-asset-library\.ts$/ }, () => ({ loader: "js", contents: `export function usePersonalAssetLibrary() { return []; }` }));
        } }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0].text();
    server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
        return new URL(request.url).pathname === "/app.js" ? new Response(script, { headers: { "Content-Type": "text/javascript" } })
            : new Response(`<style>.canvas-resource-mention-menu {position:fixed;width:320px}.canvas-resource-mention-scroll {max-height:180px;overflow:auto}.canvas-resource-mention-item {display:flex;height:40px}.canvas-resource-mention-preview {display:block;width:32px;height:32px}.inline-flex {display:inline-flex} #result {max-height:80px;overflow:hidden}</style><div id="root"></div><script type="module" src="/app.js"></script>`, { headers: { "Content-Type": "text/html" } });
    } });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ headless: true, executablePath });
    page = await browser.newPage();
    page.on("pageerror", (error) => console.error(error.message));
}, 30_000);
afterAll(async () => { await browser?.close(); server?.stop(); }, 30_000);

async function mount() {
    await page.goto(server.url.href);
    await page.waitForFunction(() => Boolean((window as any).setReferences));
}
function video(id: string, active = false) {
    return { id, nodeId: id, kind: "video", label: id, title: id, active, videoPreviewSource: { metadata: { content: id } } };
}

test("33 unused videos leave the shared preview pool available to a visible node", async () => {
    await mount();
    await page.evaluate((references) => (window as any).setReferences(references), Array.from({ length: 33 }, (_, i) => video(`unused-${i}`)));
    await page.waitForFunction(() => JSON.parse(document.querySelector("#result")!.textContent!).length === 33);
    expect(await page.evaluate(() => (window as any).probePool())).toBe(true);
    expect(await page.evaluate(() => (window as any).captures)).toEqual(["probe"]);
});

test("a slow video never delays an image; changing sources fences late completion", async () => {
    await mount();
    await page.evaluate((references) => (window as any).setReferences(references), [video("slow-old", true), { id: "image", nodeId: "image", kind: "image", label: "image", title: "image", active: true, storageKey: "image-ready" }]);
    await page.waitForFunction(() => (window as any).captures.includes("slow-old"));
    expect(await page.locator("#result").textContent()).toContain("data:image/png,image-ready");
    await page.evaluate((references) => (window as any).setReferences(references), [video("new", true)]);
    await page.waitForFunction(() => document.querySelector("#result")!.textContent!.includes("blob:"));
    await page.evaluate(() => (window as any).pending.get("slow-old")());
    expect(await page.locator("#result").textContent()).not.toContain("slow-old");
    const before = await page.locator("#result").textContent();
    await page.evaluate(() => (window as any).switchScope("second-user"));
    await page.waitForFunction((previous) => document.querySelector("#result")!.textContent !== previous && document.querySelector("#result")!.textContent!.includes("blob:"), before);
    expect(await page.locator('#resolved-previews img[data-reference-id="new"]').evaluate((image) => !(window as any).revoked.includes((image as HTMLImageElement).src))).toBe(true);
    expect(await page.evaluate(() => (window as any).revoked.length)).toBeGreaterThan(0);
    await page.evaluate(() => (window as any).setReferences([]));
    await page.waitForFunction(() => document.querySelector("#result")!.textContent === "[]");
    expect(await page.evaluate(() => (window as any).probePool())).toBe(true);
});

test("cloning reference arrays during typing keeps the visible lease alive", async () => {
    await mount();
    const reference = video("typing", true);
    await page.evaluate((references) => (window as any).setReferences(references), [reference]);
    await page.waitForFunction(() => document.querySelector("#result")!.textContent!.includes("blob:"));
    const src = await page.locator('#resolved-previews img').getAttribute("src");
    for (let i = 0; i < 4; i++) await page.evaluate((references) => (window as any).setReferences(references), [reference]);
    expect(await page.locator('#resolved-previews img').getAttribute("src")).toBe(src);
    expect(await page.evaluate((url) => (window as any).revoked.includes(url), src)).toBe(false);
    expect(await page.evaluate(() => (window as any).captures)).toEqual(["typing"]);
});

test("mention menu decodes only visible rows and releases them when closed", async () => {
    await mount();
    // A visible canvas node can hold the same poster while menu rows unmount.
    await page.evaluate(() => (window as any).holdVideo("menu-0"));
    await page.evaluate((references) => { (window as any).setReferences(references); (window as any).showMenu(); }, Array.from({ length: 40 }, (_, i) => video(`menu-${i}`)));
    const editor = page.getByRole("textbox", { name: "引用编辑" });
    await editor.pressSequentially("@menu");
    await page.locator("[data-canvas-resource-mention-menu]").waitFor({ state: "visible", timeout: 3000 });
    expect(await page.locator(".canvas-resource-mention-item").count()).toBe(40);
    // menu-0 was captured by the held canvas lease before this menu opened.
    // Wait for a different visible row before testing scrolling and disposal.
    await page.waitForFunction(() => (window as any).captures.some((url: string) => url.startsWith("menu-") && url !== "menu-0"), undefined, { timeout: 3000 });
    const first = await page.evaluate(() => [...(window as any).captures] as string[]);
    expect(first.length).toBeGreaterThan(1);
    expect(first.length).toBeLessThan(10);
    expect(first).not.toContain("menu-39");
    await page.locator(".canvas-resource-mention-scroll").evaluate((element) => { element.scrollTop = element.scrollHeight; });
    try {
        await page.waitForFunction(() => (window as any).captures.includes("menu-39"), undefined, { timeout: 5000 });
    } catch (error) {
        console.error("preview scroll state", await page.evaluate(() => {
            const scroll = document.querySelector(".canvas-resource-mention-scroll");
            return { captures: (window as any).captures, menuPresent: !!scroll, scrollTop: scroll?.scrollTop, scrollHeight: scroll?.scrollHeight, clientHeight: scroll?.clientHeight,
                rows: [...(scroll?.querySelectorAll("button") || [])].map(row => ({ title: row.textContent, y: row.getBoundingClientRect().y, height: row.getBoundingClientRect().height })) };
        }));
        throw error;
    }
    await page.locator(".canvas-resource-mention-scroll").evaluate((element) => { element.scrollTop = 0; });
    await page.waitForFunction(() => { const image = document.querySelector('.canvas-resource-mention-item img') as HTMLImageElement | null; return image && !(window as any).revoked.includes(image.src) && image.naturalWidth > 0; });
    await editor.press("Escape");
    await page.waitForFunction(() => !document.querySelector("[data-canvas-resource-mention-menu]"), undefined, { timeout: 3000 });
    expect(await page.evaluate(() => (window as any).probePool())).toBe(true);
    await editor.press("End");
    await page.waitForFunction(() => { const image = document.querySelector('.canvas-resource-mention-item img') as HTMLImageElement | null; return image && !(window as any).revoked.includes(image.src) && image.naturalWidth > 0; });
    await page.evaluate(() => (window as any).releaseHeld());
}, 30_000);
