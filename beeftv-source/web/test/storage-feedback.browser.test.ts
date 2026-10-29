import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";
import { chromium, type Browser } from "playwright";
for (const width of [1440, 390]) for (const dark of [false, true]) test(`reference transport and storage check ${width} dark=${dark}`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
        await page.goto(server.url + "?transport&auto" + (dark ? "&dark" : ""));
        await page.getByRole("combobox", { name: "图片传输方式" }).click();
        await page.getByText("直接传素材", { exact: true }).click();
        await page.getByRole("combobox", { name: "视频传输方式" }).click();
        await page.locator(".ant-select-dropdown:visible").getByText("手动填写 HTTPS 链接", { exact: true }).click();
        await page.getByRole("button", { name: "保存并测试上传" }).click();
        await page.getByText("存储测试通过", { exact: true }).waitFor();
        await page.getByText("上传、公开读取和测试文件清理均已通过", { exact: true }).waitFor();
        expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
        await page.screenshot({ path: import.meta.dir + `/../../output/reference-transport-${width}-${dark}.png`, fullPage: true });
        await page.getByRole("textbox", { name: "S3 端点" }).fill("https://changed.example.com");
        expect(await page.getByText("存储测试通过", { exact: true }).count()).toBe(0);
        expect(errors).toEqual([]);
    } finally { await page.close(); }
}, 30000);

test("failed storage check keeps an actionable HTTP status", async () => {
    const page = await browser.newPage();
    try {
        await page.goto(server.url + "?transport&auto&test-error");
        await page.getByRole("button", { name: "保存并测试上传" }).click();
        await page.getByText("存储测试未通过", { exact: true }).waitFor();
        await page.getByText(/HTTP 403/).waitFor();
        expect(await page.getByText("存储测试通过", { exact: true }).count()).toBe(0);
    } finally { await page.close(); }
}, 30000);

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
    const stubs: Record<string, string> = {
        "@/services/model-config-repository": "export const flushModelConfig=async()=>{}; export const getModelConfigPersistenceState=()=>({dirty:false,status:'ready'});",
        "@/services/local-workspace-sync": "export const saveRemoteUserDataNow=async()=>{};",
        "@/lib/canvas/canvas-project-generation": "export const isAudioFile=(file)=>file.type.startsWith('audio/');",
    };
    const build = await Bun.build({
        entrypoints: [import.meta.dir + "/fixtures/storage-feedback-harness.tsx"],
        target: "browser",
        define: { "import.meta.env": "{}", "process.env.NODE_ENV": '"production"' },
        plugins: [
            {
                name: "aliases",
                setup(builder) {
                    builder.onResolve({ filter: /^@\// }, (args) => (args.path in stubs ? { path: args.path, namespace: "stub" } : { path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
                    builder.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: stubs[args.path], loader: "tsx", resolveDir: import.meta.dir }));
                },
            },
        ],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0].text();
    const stylesheet = import.meta.dir + "/../src/styles/globals.css";
    const css = (await postcss([tailwindcss({ base: import.meta.dir + "/.." })]).process(await Bun.file(stylesheet).text(), { from: stylesheet })).css;
    server = Bun.serve({
        port: 0,
        fetch: (req) => {
            const path = new URL(req.url).pathname;
            if (path === "/app.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
            if (path === "/style.css") return new Response(css, { headers: { "Content-Type": "text/css" } });
            return new Response('<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script type="module" src="/app.js"></script>', {
                headers: { "Content-Type": "text/html" },
            });
        },
    });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 60000);
afterAll(async () => {
    await browser?.close();
    server?.stop(true);
}, 30000);
test("migration restart advice stays visible while technical details are collapsed", async () => {
    const page = await browser.newPage();
    try {
        await page.goto(server.url + "?migration-error");
        await page.getByRole("button", { name: "选择文件夹", exact: true }).click();
        await page.getByRole("button", { name: "迁移旧数据并使用新目录" }).click();
        await page.getByText("迁移未完成，原数据已保留，但工作区未能重新打开。请重启 BeefTV", { exact: true }).waitFor();
        expect(await page.getByText(/fixture failure/).isVisible()).toBe(false);
        await page.getByText("错误详情", { exact: true }).click();
        expect(await page.getByText(/fixture failure/).isVisible()).toBe(true);
    } finally {
        await page.close();
    }
}, 30000);
test("failed cleanup closes stale confirmation and retains honest retry state", async () => {
    const page = await browser.newPage();
    try {
        await page.goto(server.url + "?cleanup-error");
        expect(await page.getByText(/原目录可能已部分清理/).count()).toBe(0);
        await page.screenshot({ path: import.meta.dir + "/../../output/storage-before-cleanup.png" });
        await page.getByRole("button", { name: "清理原目录，释放磁盘空间" }).click();
        await page.getByRole("button", { name: "确认并清理", exact: true }).click();
        await page.getByRole("dialog").waitFor({ state: "detached" });
        await page.getByText("临时文件仍在使用中，请重启 BeefTV 后再次清理。当前存储目录不受影响", { exact: true }).waitFor();
        expect(await page.getByText(/原数据仍保留在/).count()).toBe(0);
        await page.getByText(/请保留当前存储目录/).waitFor();
        await page.screenshot({ path: import.meta.dir + "/../../output/storage-cleanup-interrupted.png" });
        await page.getByRole("button", { name: "清理原目录，释放磁盘空间" }).click();
        await page.getByText(/可释放约 0.0 GB/).waitFor();
    } finally {
        await page.close();
    }
}, 30000);
for (const width of [1440, 390])
    for (const dark of [false, true])
        test(`storage and URL entry ${width}px dark=${dark}`, async () => {
            const page = await browser.newPage({ viewport: { width, height: 900 } });
            const errors: string[] = [];
            page.on("pageerror", (error) => errors.push(error.message));
            try {
                await page.goto(server.url + (dark ? "?dark" : ""));
                await page.getByRole("button", { name: "选择文件夹", exact: true }).click();
                expect(await page.getByRole("textbox", { name: "新存储目录" }).inputValue()).toBe("D:\\BeefTV");
                await page.getByRole("button", { name: "迁移旧数据并使用新目录" }).click();
                await page.getByText("当前目录：D:\\BeefTV", { exact: true }).waitFor();
                await page.getByRole("button", { name: "清理原目录，释放磁盘空间" }).click();
                await page.getByRole("button", { name: "确认并清理", exact: true }).click();
                await page.getByRole("button", { name: "清理原目录，释放磁盘空间" }).waitFor({ state: "detached" });
                await page.getByRole("button", { name: "添加测试素材" }).click();
                const input = page.getByRole("textbox", { name: "在线素材地址" });
                await input.fill("http://cdn.example.com/image.png");
                expect(await page.getByRole("button", { name: "添加链接", exact: true }).isDisabled()).toBe(true);
                await input.fill("https://cdn.example.com/image.png");
                const bounds = await page.getByRole("dialog").boundingBox();
                expect(bounds!.x).toBeGreaterThanOrEqual(0);
                expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
                await page.screenshot({ path: import.meta.dir + `/../../output/storage-url-${width}-${dark}.png` });
                await page.getByRole("button", { name: "添加链接", exact: true }).click();
                await page.getByText("image:https://cdn.example.com/image.png", { exact: true }).waitFor();
                await page.getByRole("textbox", { name: "S3 端点", exact: true }).fill("https://s3.example.com");
                await page.getByRole("textbox", { name: "Secret Access Key", exact: true }).fill("fixture-secret");
                await page.getByRole("button", { name: "保存对象存储配置" }).click();
                await page.getByPlaceholder("已保存，留空保持").waitFor();
                expect(await page.getByRole("textbox", { name: "Secret Access Key", exact: true }).inputValue()).toBe("");
                expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
                expect(errors).toEqual([]);
            } finally {
                await page.close();
            }
        }, 30000);
test("enabled own storage supplies links and public-read failures allow manual HTTPS retry", async () => {
    for (const reject of [false, true]) {
        const page = await browser.newPage();
        try {
            await page.goto(server.url + "?auto" + (reject ? "&reject" : ""));
            await page.getByRole("button", { name: "生成测试", exact: true }).click();
            if (reject) {
                await page.getByText("对象存储上传未完成", { exact: true }).waitFor();
                expect(await page.getByRole("button", { name: "使用链接并生成" }).isDisabled()).toBe(true);
                await page.getByRole("textbox", { name: "参考图片", exact: true }).fill("https://cdn.example.com/manual-image");
                await page.getByRole("button", { name: "使用链接并生成" }).click();
            }
            await page.getByText(reject ? "https://cdn.example.com/manual-image" : "https://cdn.example.com/owned-image", { exact: true }).waitFor();
            expect(await page.getByRole("dialog").count()).toBe(0);
        } finally {
            await page.close();
        }
    }
}, 30000);
