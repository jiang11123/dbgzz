import { afterAll, beforeAll, expect, test } from "bun:test";
import type { BunPlugin } from "bun";
import { chromium, type Browser } from "playwright";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let status = 400;
let submissions = 0;

beforeAll(async () => {
    // Match the isolated browser harnesses, including Bun 1.3.9 alias resolution.
    const plugins: BunPlugin[] = [{ name: "test-source-alias", setup(builder) {
        builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
    } }];
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/local-database-error-harness.tsx"], plugins, target: "browser", define: { "import.meta.env": "{}", "process.env.NODE_ENV": '"production"' } });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0].text();
    server = Bun.serve({ port: 0, fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/harness.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
        if (path === "/api/tasks" && request.method === "POST") {
            submissions += 1;
            return Response.json({ code: status, reason: status === 400 ? "invalid_argument" : "internal", msg: "table tasks has no column named failure_diagnostics" }, { status });
        }
        if (path.startsWith("/api/")) return Response.json({ code: 0, data: [] });
        return new Response('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/harness.js"></script>', { headers: { "Content-Type": "text/html" } });
    } });
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true });
}, 30_000);

afterAll(async () => { await browser?.close(); server?.stop(true); });

for (const httpStatus of [400, 500]) {
    for (const width of [1280, 390]) {
        test(`HTTP ${httpStatus} SQLite schema failure shows local database recovery at ${width}px`, async () => {
            status = httpStatus;
            submissions = 0;
            const page = await browser.newPage({ viewport: { width, height: 800 } });
            const errors: string[] = [];
            page.on("pageerror", (error) => errors.push(error.message));
            try {
                await page.goto(server.url.toString());
                await page.getByRole("button", { name: "提交测试任务", exact: true }).click();
                const notice = page.getByRole("region", { name: "生成错误" });
                await notice.getByText("本地数据库无法读写", { exact: true }).waitFor();
                expect(await notice.getAttribute("data-category")).toBe("local_storage");
                expect(await notice.getByText("本地数据库无法读写", { exact: true }).isVisible()).toBe(true);
                expect(await notice.getByText("请重启应用；若仍失败，请保留排查信息并联系支持，不要重复生成", { exact: true }).isVisible()).toBe(true);
                expect(await notice.getByRole("button", { name: "复制排查信息", exact: true }).isVisible()).toBe(true);
                expect(await notice.getByRole("button", { name: "重新生成", exact: true }).count()).toBe(0);
                expect(await notice.innerText()).not.toContain("模型不接受当前参数");
                expect(await notice.innerText()).not.toContain("failure_diagnostics");
                expect(await page.getByRole("status", { name: "重试次数" }).innerText()).toBe("0");
                expect(submissions).toBe(1);
                expect(errors).toEqual([]);
            } finally {
                await page.close();
            }
        });
    }
}
