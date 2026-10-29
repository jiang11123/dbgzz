import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";
import { chromium, type Browser } from "playwright";
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
    const stubs: Record<string, string> = {
        "@/hooks/use-desktop-update": `export const useDesktopUpdate=()=>{ const state={status:'error',phase:'extracting',currentVersion:'v1.7.20',latestVersion:'v1.7.23',downloadedBytes:181718947,totalBytes:181718947,completedFiles:37,totalFiles:15558,error:'解压更新包超时，当前版本未被替换。请重试；再次失败时请导出诊断包。'}; return {state,runtime:'desktop',snapshot:{state,runtime:'desktop'},persistBusy:false,actionBusy:false,canForceInstall:false}; };`,
        "@/components/layout/app-changelog-modal": `export const APP_VERSION='v1.7.20'; export const AppChangelogButton=()=> <span>v1.7.20</span>;`,
        "@/services/diagnostics/diagnostics-api": `export const previewDiagnosticBundle=async()=>({taskCount:0,apiCallCount:0,updateLog:{status:'available',lines:4,truncated:false}}); export const exportDiagnosticBundle=async()=>({bundleId:'DIAG_FIXTURE'}); export const downloadDiagnosticBundle=async()=>{window.exported++;return 'saved'};`,
        "@/services/diagnostics/client-diagnostics": `export const getClientDiagnosticEvents=()=>[]; export const getClientDiagnosticSnapshot=async()=>({events:[],coverage:{status:'available',launchId:'fixture-launch',sessionCount:1,retainedCount:0,exportedCount:0,droppedCount:0,expiredCount:0,writeErrorCount:0,readErrorCount:0,maxAgeHours:24,maxEvents:500,maxBytes:524288,persisted:true}}); export const getDiagnosticRuntime=()=>({});`,
    };
    const build = await Bun.build({ entrypoints: [import.meta.dir+"/fixtures/update-diagnostics-harness.tsx"], target: "browser", define: { "import.meta.env": "{}", "process.env.NODE_ENV": '"production"', "__APP_VERSION__": '"v1.7.20"' }, plugins: [{ name: "aliases", setup(builder) {
        builder.onResolve({ filter: /^@\// }, args => args.path in stubs ? { path: args.path, namespace: "stub" } : { path: Bun.resolveSync("../src/"+args.path.slice(2), import.meta.dir) });
        builder.onLoad({ filter: /.*/, namespace: "stub" }, args => ({ contents: stubs[args.path], loader: "tsx", resolveDir: import.meta.dir }));
    } }] });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs.find(item=>item.path.endsWith(".js"))!.text();
    const stylesheet=import.meta.dir+"/../src/styles/globals.css";
    let css=(await postcss([tailwindcss({base:import.meta.dir+"/.."})]).process(await Bun.file(stylesheet).text(),{from:stylesheet})).css;
    css += await Bun.file(import.meta.dir+"/../src/components/layout/workspace-sidebar-update.css").text();
    server=Bun.serve({port:0,fetch:req=>new URL(req.url).pathname==="/app.js" ? new Response(script,{headers:{"Content-Type":"text/javascript"}}) : new URL(req.url).pathname==="/style.css" ? new Response(css,{headers:{"Content-Type":"text/css"}}) : new Response('<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script type="module" src="/app.js"></script>',{headers:{"Content-Type":"text/html"}})});
    const executablePath=[process.env.CHROME_PATH,"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path):path is string=>Boolean(path&&existsSync(path)));
    browser=await chromium.launch({executablePath,headless:true});
    mkdirSync(import.meta.dir+"/../../output/update-diagnostics",{recursive:true});
},60000);
afterAll(async()=>{await browser?.close();server?.stop(true);});

for (const width of [390,1440]) for (const dark of [false,true]) test(`update failure diagnosis ${width} dark=${dark}`,async()=>{
    const page=await browser.newPage({viewport:{width,height:850}});
    const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
    try {
        await page.goto(server.url+(dark?"?dark":""));
        await page.getByRole("button",{name:"更新失败排查",exact:true}).click();
        await page.getByText("诊断包将包含 4 条更新记录。",{exact:true}).waitFor();
        await page.getByRole("button",{name:"打开日志文件夹",exact:true}).click();
        expect(await page.evaluate(()=>(window as any).openedLogs)).toBe(1);
        await page.getByRole("button",{name:"导出诊断包",exact:true}).click();
        await page.getByText("诊断编号：DIAG_FIXTURE",{exact:true}).waitFor();
        expect(await page.evaluate(()=>(window as any).exported)).toBe(1);
        const bounds=await page.getByRole("dialog").boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(width);
        expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
        await page.screenshot({path:import.meta.dir+`/../../output/update-diagnostics/${width}-${dark}.png`});
        expect(errors).toEqual([]);
    } finally { await page.close(); }
},30000);

test("collapsed sidebar still offers diagnosis and folder failure is actionable",async()=>{
    const page=await browser.newPage();
    try {
        await page.goto(server.url+"?collapsed&open-fails");
        await page.getByRole("button",{name:"更新失败排查",exact:true}).waitFor({state:"visible"});
        expect(await page.getByRole("button",{name:"更新失败排查",exact:true}).isVisible()).toBe(true);
        await page.getByRole("button",{name:"更新失败排查",exact:true}).click();
        await page.getByRole("button",{name:"打开日志文件夹",exact:true}).click();
        await page.getByText("无法打开日志文件夹，请在存储设置中查看当前目录。",{exact:true}).waitFor();
    } finally { await page.close(); }
},30000);
