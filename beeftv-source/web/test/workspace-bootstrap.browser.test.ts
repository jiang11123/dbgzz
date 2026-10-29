import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
    const stubs: Record<string, string> = {
        "@/stores/use-user-store": 'import { create } from "zustand"; export const useUserStore = create(set => ({ hydrated: false, setHydrated: hydrated => set({ hydrated }) }));',
        "@/stores/use-config-store": 'import { create } from "zustand"; export const useConfigStore = create(set => ({ config: { channels: [] }, replaceConfig: config => set({config}) })); export const normalizeConfigSnapshot = value => value;',
        "@/lib/user-session": 'import { useUserStore } from "@/stores/use-user-store"; export const localWorkspaceConfig = value => value; export async function applyUserSession() { useUserStore.getState().setHydrated(true); window.sessionReady = true; }',
        "@/services/api/workspace": 'export async function getWorkspaceBootstrap() { return {}; }',
        "@/services/model-config-repository": 'export const commitModelConfig = async () => { window.writes = (window.writes || 0) + 1; }; export const flushModelConfig = async () => {}; export const hydrateModelConfig = () => new Promise((resolve, reject) => { window.finishRestore = () => resolve({config:{channels:[{id:"fixture",apiKey:"restored"}]},health:"ready"}); window.failRestore = () => reject(new Error("read failed")); });',
        "@/lib/app-routing": 'export const appPathname = () => "/";',
        "@/lib/workspace-route-modules": 'export const preloadWorkspaceRoute = () => {};',
        "@/components/ui/aceternity/full-screen-loader": 'export const FullScreenLoader = ({label}) => <div role="status">{label}</div>;',
        "@/components/layout/workspace-state": 'export const WorkspaceErrorState = ({title,onRetry}) => <div role="alert">{title}<button onClick={onRetry}>重新加载</button></div>;',
    };
    const build = await Bun.build({
        entrypoints: [import.meta.dir + "/fixtures/workspace-bootstrap-harness.tsx"], target: "browser",
        define: { "process.env.NODE_ENV": '"production"' },
        plugins: [{ name: "bootstrap-dependencies", setup(builder) {
            builder.onResolve({ filter: /^@\// }, args => args.path in stubs
                ? { path: args.path, namespace: "bootstrap-test" }
                : { path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) });
            builder.onLoad({ filter: /.*/, namespace: "bootstrap-test" }, args => ({ contents: stubs[args.path], loader: "tsx", resolveDir: import.meta.dir }));
        } }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const js = await build.outputs[0].text();
    server = Bun.serve({ port: 0, fetch: req => new URL(req.url).pathname === "/harness.js"
        ? new Response(js, { headers: { "Content-Type": "application/javascript" } })
        : new Response('<div id="root"></div><script type="module" src="/harness.js"></script>', { headers: { "Content-Type": "text/html" } }) });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p): p is string => Boolean(p && existsSync(p)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 60000);
afterAll(async () => { await browser?.close(); server?.stop(true); });

test("session-ready cannot expose generation until canonical credentials are restored", async () => {
    const page = await browser.newPage(); await page.goto(server.url.toString());
    await page.waitForFunction(() => (window as any).sessionReady && (window as any).finishRestore);
    expect(await page.getByRole("button", { name: "开始创作" }).count()).toBe(0);
    expect(await page.getByRole("status").textContent()).toContain("正在准备");
    await page.evaluate(() => (window as any).finishRestore());
    await page.getByRole("button", { name: "开始创作" }).waitFor();
    expect(await page.getByRole("status").count()).toBe(0);
    await page.close();
});

test("failed canonical restore shows retry without exposing blank-credential generation or autosaving", async () => {
    const page = await browser.newPage(); await page.goto(server.url.toString());
    await page.waitForFunction(() => Boolean((window as any).failRestore));
    await page.evaluate(() => (window as any).failRestore());
    await page.getByRole("alert").waitFor();
    expect(await page.getByRole("button", { name: "开始创作" }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "重新加载" }).count()).toBe(1);
    expect(await page.evaluate(() => (window as any).writes || 0)).toBe(0);
    await page.close();
});
