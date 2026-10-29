import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { chromium, type Browser } from "playwright";

let browser: Browser, server: ReturnType<typeof Bun.serve>;
let scratch: string;
const resources = new Map<string, { bytes: Buffer; kind: string; mimeType: string }>();
const chats: Record<string, any>[] = [], supplements: Record<string, any>[] = [];
const externalConnections: Record<string, any>[] = [];
const undoRequests: Record<string, any>[] = [];
let rejectNextUndo = false;
let running = false, cancelled = false, nextId = 0, failNextAsset = false;
let activePermissionMode: string | undefined;
let holdNextAsset = false, releaseAsset: (() => void) | null = null;
let assetHeld: (() => void) | null = null;
const uploadKeys: string[] = [];
const uploadMetadata: { name: string; width: string | null; height: string | null; durationMs: string | null }[] = [];
const registeredAssets: Record<string, any>[] = [];
let assetScope = "guest";
const turns: Record<string, any>[] = [];
let png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl9sAAAAASUVORK5CYII=", "base64");
let wav: Buffer, longWav: Buffer, video: Buffer, jpeg: Buffer;
const mediaRequests: { path: string; token: string | null }[] = [];
let holdFirstPreview = true, releaseFirstPreview: (() => void) | null = null;
const selectedSkill = { skillId: "story", versionId: "story-v1", contentHash: "a".repeat(64), skillName: "分镜", version: "1.0", status: 1, isAdded: true };
let installedSkills = [selectedSkill];
const skillInstalls: { sourceType: string; isPrivate: string; fileName: string }[] = [];
let holdSkillInstall = false, releaseSkillInstall: (() => void) | null = null;
beforeAll(async () => {
    scratch = mkdtempSync(tmpdir() + "/assistant-input-");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=24000:duration=0.25", scratch + "/beat.wav"]);
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=24000:duration=12", scratch + "/long-beat.wav"]);
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=red:s=64x48:r=24:d=0.25", "-c:v", "libx264", "-pix_fmt", "yuv420p", scratch + "/motion.mp4"]);
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=blue:s=64x48", "-frames:v", "1", "-threads", "1", scratch + "/portrait.png"]);
    png = readFileSync(scratch + "/portrait.png");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=blue:s=64x48", "-frames:v", "1", "-threads", "1", scratch + "/portrait.jpg"]);
    jpeg = readFileSync(scratch + "/portrait.jpg");
    wav = readFileSync(scratch + "/beat.wav"); video = readFileSync(scratch + "/motion.mp4");
    longWav = readFileSync(scratch + "/long-beat.wav");
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/assistant-input-harness.tsx"], target: "browser", define: {
        "import.meta.env.DEV": "false", "import.meta.env.PROD": "true", "import.meta.env.MODE": '"production"', "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"true"',
        "import.meta.env.VITE_CANVAS_BACKEND_URL": '"/api"', "process.env.NODE_ENV": '"production"',
    }, plugins: [{ name: "test-source", setup(builder) {
        builder.onResolve({ filter: /^@\/components\/model-logo$/ }, () => ({ path: "model-logo", namespace: "test-icons" }));
        builder.onLoad({ filter: /.*/, namespace: "test-icons" }, () => ({ contents: "export function ModelLogo() { return null; }", loader: "js" }));
        builder.onResolve({ filter: /^@\// }, args => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
    } }] });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const js = await build.outputs.find(output => output.path.endsWith(".js"))!.text(), css = await build.outputs.find(output => output.path.endsWith(".css"))?.text() || "";
    const ok = (data: unknown) => Response.json({ code: 0, data });
    server = Bun.serve({ port: 0, async fetch(req) {
        const pathname = new URL(req.url).pathname;
        if (pathname === "/harness.js") return new Response(js, { headers: { "content-type": "application/javascript" } });
        if (pathname === "/harness.css") return new Response(css, { headers: { "content-type": "text/css" } });
        if (pathname === "/api/agent-clients" && req.method === "POST") {
            externalConnections.push(await req.json());
            return ok({ client: { id: "external-fixture", kind: "codex", label: "Codex", mode: "read-write" }, setup: { kind: "codex", title: "Codex", command: "beeftv connect fixture-only" } });
        }
        if (pathname === "/api/resources" && req.method === "POST") {
            uploadKeys.push(req.headers.get("X-Idempotency-Key") || "");
            const form = await req.formData(), file = form.get("file") as File, kind = String(form.get("kind"));
            uploadMetadata.push({ name: file.name, width: form.get("width") as string | null, height: form.get("height") as string | null, durationMs: form.get("durationMs") as string | null });
            const id = "r" + (++nextId); resources.set(id, { bytes: Buffer.from(await file.arrayBuffer()), kind, mimeType: file.type });
            // The real local resource service can omit dimensions/duration in a ready receipt.
            return ok({ resource: { id, status: "ready", kind, mimeType: file.type, size: file.size } });
        }
        if (pathname.startsWith("/api/resources/") && pathname.endsWith("/file")) {
            mediaRequests.push({ path: new URL(req.url).pathname + new URL(req.url).search, token: req.headers.get("X-Desktop-Token") });
            if (req.headers.get("X-Desktop-Token") !== "synthetic-desktop-preview") return Response.json({ code: 403 }, { status: 403 });
            if (holdFirstPreview && pathname.includes("/r1/")) { holdFirstPreview = false; await new Promise<void>(resolve => { releaseFirstPreview = resolve; }); }
            const file = resources.get(pathname.split("/")[3]) || { bytes: png, mimeType: "image/png" };
            return new Response(file.bytes, { headers: { "content-type": file.mimeType } });
        }
        if (/^\/api\/resources\/[^/]+$/.test(pathname)) {
            const id = pathname.split("/")[3], file = resources.get(id);
            return ok({ resource: { id, status: "ready", provider: "local", kind: file?.kind || "video", playbackStatus: file?.kind === "video" ? "ready" : "none" } });
        }
        if (pathname.startsWith("/api/assets/") && req.method === "PUT") {
            if (failNextAsset) { failNextAsset = false; return Response.json({ code: 500, message: "素材登记失败" }, { status: 500 }); }
            const body = await req.json();
            if (holdNextAsset) { holdNextAsset = false; await new Promise<void>(resolve => { releaseAsset = resolve; assetHeld?.(); }); }
            registeredAssets.push(body.asset);
            return ok({ asset: { id: body.asset.id } });
        }
        if (pathname === "/test/asset-scope") { assetScope = (await req.json()).scope; return ok({}); }
        if (pathname === "/api/assets" && req.method === "GET") {
            const assets = assetScope === "guest" ? registeredAssets : [];
            return ok({ assets, page: 1, pageSize: 100, total: assets.length, hasMore: false });
        }
        if (pathname.endsWith("/skills/install")) {
            const form = await req.formData();
            skillInstalls.push({ sourceType: String(form.get("sourceType")), isPrivate: String(form.get("isPrivate")), fileName: (form.get("file") as File).name });
            if (holdSkillInstall) await new Promise<void>(resolve => { releaseSkillInstall = resolve; });
            const skill = { ...selectedSkill, skillId: "coffee", skillName: "咖啡审片", versionId: "coffee-v2", version: "2.0", contentHash: "b".repeat(64) };
            installedSkills = [skill];
            return ok({ skill });
        }
        if (pathname.endsWith("/skills/added")) return ok({ skills: installedSkills });
        if (pathname.endsWith("/assistant/ui-session")) return ok({ token: "synthetic-only", expiresAt: new Date(Date.now() + 1800000).toISOString() });
        if (pathname.endsWith("/assistant/status")) return ok({ available: true });
        if (pathname.endsWith("/assistant/sessions")) return ok({ currentSessionId: "s1", sessions: [] });
        if (pathname.endsWith("/assistant/history")) return ok({ sessionId: "s1", turns, active: running && !cancelled ? { turnId: "busy", userText: "继续创作", permissionMode: activePermissionMode, selectedNodeIds: [], attachments: [], skills: [], supplements: [], status: "running", createdAt: "2026-10-08" } : null });
        if (pathname.endsWith("/assistant/steer")) { supplements.push(await req.json()); return ok({ accepted: true }); }
        if (pathname.endsWith("/assistant/cancel")) { cancelled = true; running = false; return ok({ accepted: true }); }
        if (pathname.includes("/assistant/turns/") && pathname.endsWith("/undo")) {
            undoRequests.push(await req.json());
            if (rejectNextUndo) { rejectNextUndo = false; return Response.json({ code: 409, reason: "canvas_changed_since_turn" }, { status: 409 }); }
            return ok({ revision: 3 });
        }
        if (pathname.endsWith("/assistant/chat")) {
            const body = await req.json(); chats.push(body);
            const mainChange = { revisionBefore: 1, revisionAfter: 2, createdNodeIds: ["main-new"], updatedNodeIds: [], deletedNodeIds: ["gone"], createdEdgeIds: [], deletedEdgeIds: ["old-edge"] };
            const change = body.message === "改两个画布" ? { ...mainChange, canvasChanges: [
                { ...mainChange, canvasId: "input-canvas", operationIds: ["op1"] },
                { revisionBefore: 4, revisionAfter: 5, createdNodeIds: ["other-new"], updatedNodeIds: [], createdEdgeIds: [], timelineUpdated: true, canvasId: "other-canvas", operationIds: ["op2"] },
            ] } : null;
            const turn = { turnId: "t" + chats.length, userText: body.message, permissionMode: body.permissionMode, selectedNodeIds: [], reply: "已读取提供的参考素材。", attachments: body.attachments, skills: body.skills,
                toolCalls: [], proposals: [], change, error: null, cancelled: false, createdAt: "2026-10-08" };
            turns.push(turn);
            return new Response(JSON.stringify({ type: "turn_end", ...turn }) + "\n", { headers: { "content-type": "application/x-ndjson" } });
        }
        if (pathname.startsWith("/api/")) return ok({});
        return new Response('<html><meta name="viewport" content="width=device-width"><style>:root{--background:#fff;--foreground:#222;--muted:#f4f4f4;--muted-foreground:#666;--border:#ddd;--card:#fff;--fs-body:14px}*{box-sizing:border-box}body{margin:0}</style><link rel="stylesheet" href="/harness.css"><div id="root"></div><script type="module" src="/harness.js"></script></html>', { headers: { "content-type": "text/html" } });
    } });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((item): item is string => Boolean(item && existsSync(item)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 60000);
afterAll(async () => { await browser?.close(); server?.stop(true); if (scratch) rmSync(scratch, { recursive: true, force: true }); });
beforeEach(() => { registeredAssets.length = 0; assetScope = "guest"; });

test("real Sidebar handles file, paste, drop, attachment-only, purpose/range, draft restore and busy supplement", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } }); await page.goto(server.url.toString().replace("localhost", "127.0.0.1"));
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('button[aria-label="添加参考素材"]')?.disabled);
    await page.locator('input[type="file"]').setInputFiles({ name: "portrait.jpg", mimeType: "image/jpeg", buffer: jpeg });
    await page.getByRole("combobox", { name: "portrait.jpg 的用途" }).waitFor();
    await page.getByText("正在读取预览…", { exact: true }).waitFor({ timeout: 3000 }).catch(async error => { throw new Error(error.message + " BODY " + await page.locator("body").innerText() + " MEDIA " + JSON.stringify(mediaRequests)); });
    expect(releaseFirstPreview).not.toBeNull(); releaseFirstPreview!();
    await page.waitForFunction(() => { const image = document.querySelector<HTMLImageElement>('img[alt="portrait.jpg"]'); return image?.src.startsWith("blob:") && image.complete && image.naturalWidth === 64; });
    expect(mediaRequests.some(item => item.token === "synthetic-desktop-preview" && item.path.includes("proxy=1"))).toBe(true);
    await page.getByRole("combobox", { name: "portrait.jpg 的用途" }).click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option-content').getByText("首帧", { exact: true }).waitFor();
    const imagePurposes = await (await page.waitForFunction(() => { const labels = [...document.querySelectorAll(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content")].map(item => item.textContent); return labels.length === 6 ? labels : null; })).jsonValue();
    expect(imagePurposes).toContain("首帧"); expect(imagePurposes).toContain("人物参考");
    expect(imagePurposes).not.toContain("声音参考"); expect(imagePurposes).not.toContain("节奏参考");
    await page.getByRole("combobox", { name: "portrait.jpg 的用途" }).press("Escape");
    await page.getByRole("button", { name: "选择技能", exact: true }).click(); await page.getByRole("button", { name: "分镜 · 1.0", exact: true }).click();
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await page.getByText("已读取提供的参考素材。", { exact: true }).waitFor();
    expect(chats[0]?.message).toBe(""); expect(chats[0]?.attachments[0]?.assetId).toBeDefined();
    expect(chats[0]?.references).toEqual([{ kind: "asset", id: chats[0]?.attachments[0]?.assetId }]);
    expect(chats[0]?.skills).toEqual([{ skillId: "story", versionId: "story-v1", contentHash: "a".repeat(64) }]);
    await page.evaluate(bytes => { const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(bytes)], "paste.png", { type: "image/png" })); document.querySelector('.canvas-assistant-composer')!.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: transfer })); }, [...png]);
    await page.getByRole("combobox", { name: "paste.png 的用途" }).waitFor();
    await page.evaluate(bytes => { const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(bytes)], "motion.mp4", { type: "video/mp4" })); document.querySelector('.canvas-assistant-composer')!.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: transfer })); }, [...video]);
    await page.getByRole("combobox", { name: "motion.mp4 的用途" }).waitFor();
    await page.waitForFunction(() => { const video = document.querySelector<HTMLVideoElement>('video[aria-label="motion.mp4"]'); return video?.src.startsWith("blob:") && video.readyState >= 1 && video.videoWidth === 64; });
    expect(mediaRequests.some(item => item.path.includes("variant=playback") && item.token === "synthetic-desktop-preview")).toBe(true);
    await page.getByRole("combobox", { name: "motion.mp4 的用途" }).click(); await page.locator('.ant-select-item-option-content').getByText("运镜参考", { exact: true }).click();
    await page.getByRole("spinbutton", { name: "motion.mp4 起始秒" }).fill("0"); await page.getByRole("spinbutton", { name: "motion.mp4 结束秒" }).fill("0.2");
    await page.getByRole("spinbutton", { name: "motion.mp4 结束秒" }).press("Tab");
    await page.waitForFunction(async () => (await (window as any).assistantInputFixture.draft())?.attachments.some((item: any) => item.name === "motion.mp4" && item.end === 0.2));
    await page.reload(); await page.getByRole("combobox", { name: "motion.mp4 的用途" }).waitFor();
    expect(await page.getByRole("spinbutton", { name: "motion.mp4 结束秒" }).inputValue()).toBe("0.2");
    await page.getByRole("button", { name: "画布素材", exact: true }).click(); await page.getByRole("button", { name: "画布人像", exact: true }).click();
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.canvas-assistant-log .canvas-assistant-reply').length === 2);
    expect(chats[1]?.attachments.some((item: any) => item.name === "motion.mp4" && item.purpose === "motion" && item.end === 0.2)).toBe(true);
    expect(chats[1]?.attachments.some((item: any) => item.nodeId === "n1" && item.resourceId === "existing")).toBe(true);
    running = true; await page.reload(); await page.getByRole("button", { name: "停止", exact: true }).waitFor();
    await page.locator('input[type="file"]').setInputFiles({ name: "beat.wav", mimeType: "audio/wav", buffer: wav });
    await page.getByRole("combobox", { name: "beat.wav 的用途" }).waitFor();
    await page.waitForFunction(() => { const audio = document.querySelector<HTMLAudioElement>('audio[aria-label="beat.wav"]'); return audio?.src.startsWith("blob:") && audio.readyState >= 1; });
    expect(mediaRequests.every(item => item.token === "synthetic-desktop-preview")).toBe(true);
    await page.getByRole("combobox", { name: "beat.wav 的用途" }).click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option-content').getByText("声音参考", { exact: true }).waitFor();
    const audioPurposes = await (await page.waitForFunction(() => { const labels = [...document.querySelectorAll(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content")].map(item => item.textContent); return labels.length === 3 ? labels : null; })).jsonValue();
    expect(audioPurposes).toEqual(["仅分析", "节奏参考", "声音参考"]);
    expect(audioPurposes).not.toContain("首帧"); expect(audioPurposes).not.toContain("人物参考");
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option-content').getByText("声音参考", { exact: true }).click();
    await page.getByRole("button", { name: /^补\s*充$/ }).click({ timeout: 8000 }).catch(async error => { throw new Error(error.message + " UI " + await page.locator('body').innerText()); }); await page.getByText("助手已收到补充要求。", { exact: true }).waitFor({ timeout: 8000 });
    expect(supplements).toHaveLength(1); expect(supplements[0]?.message).toBe(""); expect(supplements[0]?.attachments[0]?.kind).toBe("audio"); expect(supplements[0]?.attachments[0]?.purpose).toBe("sound");
    expect(chats).toHaveLength(2);
    running = false;
    turns.push({ turnId: "busy", userText: "继续创作", selectedNodeIds: [], reply: "补充的音频已加入本次创作。", attachments: [], skills: [], supplements: [], supplementInputs: supplements.map(item => ({ message: item.message, attachments: item.attachments, skills: item.skills })), toolCalls: [], proposals: [], change: null, error: null, cancelled: false, createdAt: "2026-10-08" });
    await page.getByText("补充的音频已加入本次创作。", { exact: true }).waitFor({ timeout: 8000 });
    expect(await page.getByRole("button", { name: "停止", exact: true }).count()).toBe(0);
    expect(chats).toHaveLength(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: "/tmp/beeftv-assistant-input-ui.png" }); await page.close();
}, 30000);

test("asset registration failure remains unsent; explicit upload retry keeps its idempotency key and invalid range blocks send", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    await page.goto(server.url.toString().replace("localhost", "127.0.0.1"));
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('button[aria-label="添加参考素材"]')?.disabled);
    const before = chats.length, firstKey = uploadKeys.length;
    failNextAsset = true;
    await page.locator('input[type="file"]').setInputFiles({ name: "retry.png", mimeType: "image/png", buffer: png });
    await page.getByRole("button", { name: "重试上传", exact: true }).waitFor();
    expect(await page.evaluate(() => (window as any).assistantInputFixture.assets())).toEqual([]);
    expect(await page.evaluate(() => (window as any).assistantInputFixture.libraryInvalidated())).toBe(false);
    expect(await page.getByRole("button", { name: "发送", exact: true }).isDisabled()).toBe(true);
    expect(chats).toHaveLength(before);
    await page.getByRole("button", { name: "重试上传", exact: true }).click();
    await page.getByRole("combobox", { name: "retry.png 的用途" }).waitFor();
    expect(uploadKeys[firstKey]).not.toBe(""); expect(uploadKeys[firstKey + 1]).toBe(uploadKeys[firstKey]);
    await page.locator('input[type="file"]').setInputFiles({ name: "range.wav", mimeType: "audio/wav", buffer: wav });
    await page.getByRole("spinbutton", { name: "range.wav 结束秒" }).fill("3");
    await page.getByText("结束时间超过素材时长", { exact: true }).waitFor();
    expect(await page.getByRole("button", { name: "发送", exact: true }).isDisabled()).toBe(true);
    expect(chats).toHaveLength(before);
    await page.waitForFunction(async () => (await (window as any).assistantInputFixture.draft())?.attachments.some((item: any) => item.name === "range.wav" && item.end === 3));
    await page.evaluate(() => new Promise<void>((resolve, reject) => {
        const opening = indexedDB.open("beeftv-assistant-input");
        opening.onerror = () => reject(opening.error);
        opening.onsuccess = () => {
            const database = opening.result, transaction = database.transaction("drafts", "readwrite"), store = transaction.objectStore("drafts");
            const read = store.get("guest:input-canvas");
            read.onsuccess = () => { const draft = read.result; draft.attachments.find((item: { kind: string }) => item.kind === "audio").purpose = "first-frame"; store.put(draft, "guest:input-canvas"); };
            transaction.oncomplete = () => { database.close(); resolve(); };
            transaction.onerror = () => reject(transaction.error);
        };
    }));
    await page.reload();
    const legacy = page.locator('.canvas-assistant-attachment').filter({ hasText: "range.wav" });
    await legacy.locator('.ant-select').getByText("首帧", { exact: true }).waitFor({ timeout: 4000 }).catch(async error => { throw new Error(error.message + " UI " + await page.locator("body").innerText()); });
    expect(await legacy.locator('.ant-select').innerText()).toBe("首帧");
    await page.getByRole("combobox", { name: "range.wav 的用途" }).click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option-content').getByText("声音参考", { exact: true }).waitFor();
    expect(await (await page.waitForFunction(() => { const labels = [...document.querySelectorAll(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content")].map(item => item.textContent); return labels.length === 3 ? labels : null; })).jsonValue()).toEqual(["仅分析", "节奏参考", "声音参考"]);
    await page.getByRole("combobox", { name: "range.wav 的用途" }).press("Escape");
    await page.waitForFunction(async () => (await (window as any).assistantInputFixture.draft())?.attachments.some((item: any) => item.name === "range.wav" && item.purpose === "first-frame"));
    expect(await legacy.locator('.ant-select').innerText()).toBe("首帧");
    await page.close();
}, 15000);

test("native-local Sidebar publishes accepted uploads for immediate @ reuse, while removal and scope changes preserve ownership", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    await page.goto(server.url.toString().replace("localhost", "127.0.0.1"));
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('button[aria-label="添加参考素材"]')?.disabled);
    expect(await page.evaluate(() => (window as any).assistantInputFixture.nativeLocal())).toBe(true);
    await page.locator('input[type="file"]').setInputFiles({ name: "reuse.jpg", mimeType: "image/jpeg", buffer: jpeg });
    await page.getByRole("combobox", { name: "reuse.jpg 的用途" }).waitFor();
    const registered = await page.evaluate(() => (window as any).assistantInputFixture.assets());
    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({ title: "reuse.jpg", kind: "image" });
    expect(registered[0].data).toMatchObject({ width: 64, height: 48 });
    expect(registeredAssets.find(asset => asset.id === registered[0].id)?.data).toEqual(registered[0].data);
    expect(uploadMetadata.find(upload => upload.name === "reuse.jpg")).toMatchObject({ width: "64", height: "48" });
    expect(await page.evaluate(() => (window as any).assistantInputFixture.libraryInvalidated())).toBe(true);
    await page.getByRole("button", { name: "移除 reuse.jpg", exact: true }).click();
    expect(await page.evaluate(() => (window as any).assistantInputFixture.assets())).toEqual(registered);
    await page.getByRole("textbox", { name: "给助手的消息" }).fill("@reuse");
    await page.locator('.canvas-resource-mention-item').getByText("reuse.jpg", { exact: true }).click();
    const before = chats.length;
    const sent = page.waitForResponse(response => response.url().endsWith("/assistant/chat"));
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await sent;
    await page.getByText("已读取提供的参考素材。", { exact: true }).last().waitFor();
    expect(chats).toHaveLength(before + 1);
    expect(chats[before]?.message).toContain(`@[asset:${registered[0].id}]`);
    expect(chats[before]?.references).toEqual([{ kind: "asset", id: registered[0].id }]);
    expect(chats[before]?.attachments).toBeUndefined();

    const held = new Promise<void>(resolve => { assetHeld = resolve; });
    holdNextAsset = true;
    await page.locator('input[type="file"]').setInputFiles({ name: "old-account.png", mimeType: "image/png", buffer: png });
    await held;
    await page.evaluate(() => (window as any).assistantInputFixture.switchScope());
    const completed = page.waitForResponse(response => response.request().method() === "PUT" && response.url().includes("/api/assets/"));
    releaseAsset!(); await completed;
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('button[aria-label="添加参考素材"]')?.disabled);
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => (window as any).assistantInputFixture.assets())).toEqual([]);
    expect(await page.getByRole("combobox", { name: "old-account.png 的用途" }).count()).toBe(0);
    await page.close();
}, 15000);

test("missing resource duration is recovered from a real twelve-second WAV for registration, draft and range validation", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    await page.goto(server.url.toString().replace("localhost", "127.0.0.1"));
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('button[aria-label="添加参考素材"]')?.disabled);
    await page.locator('input[type="file"]').setInputFiles({ name: "twelve-seconds.wav", mimeType: "audio/wav", buffer: longWav });
    await page.getByRole("combobox", { name: "twelve-seconds.wav 的用途" }).waitFor();
    await page.waitForFunction(async () => (await (window as any).assistantInputFixture.draft())?.attachments.some((item: any) => item.name === "twelve-seconds.wav" && item.durationMs === 12000));
    expect(uploadMetadata.find(upload => upload.name === "twelve-seconds.wav")?.durationMs).toBe("12000");
    const draft = await page.evaluate(() => (window as any).assistantInputFixture.draft());
    expect(draft.attachments[0].durationMs).toBe(12000);
    expect(registeredAssets.find(asset => asset.title === "twelve-seconds.wav")?.data.durationMs).toBe(12000);
    expect((await page.evaluate(() => (window as any).assistantInputFixture.assets()))[0].data.durationMs).toBe(12000);
    const before = chats.length;
    await page.getByRole("spinbutton", { name: "twelve-seconds.wav 结束秒" }).fill("12.1");
    await page.getByText("结束时间超过素材时长", { exact: true }).waitFor();
    expect(await page.getByRole("button", { name: "发送", exact: true }).isDisabled()).toBe(true);
    expect(chats).toHaveLength(before);
    await page.close();
}, 15000);

test("permission choices persist by workspace; trusted active mode locks the turn and supplements cannot elevate it", async () => {
    running = false; cancelled = false;
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    await page.goto(server.url.toString().replace("localhost", "127.0.0.1"));
    const selector = page.getByRole("combobox", { name: "助手权限" });
    await page.waitForFunction(() => !document.querySelector<HTMLInputElement>('input[aria-label="助手权限"]')?.disabled);
    const selectedText = () => selector.locator('xpath=ancestor::div[contains(@class,"ant-select")][1]').innerText();
    expect(await selectedText()).toBe("当前画布");
    await selector.click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option-content').getByText("完全访问", { exact: true }).click();
    await page.getByRole("textbox", { name: "给助手的消息" }).fill("查看全部项目");
    const sent = page.waitForResponse(response => response.url().endsWith("/assistant/chat"));
    await page.getByRole("button", { name: "发送", exact: true }).click(); await sent;
    expect(chats.at(-1)?.permissionMode).toBe("full-access");
    await page.reload();
    await page.waitForFunction(() => !document.querySelector<HTMLInputElement>('input[aria-label="助手权限"]')?.disabled);
    expect(await selectedText()).toBe("完全访问");
    activePermissionMode = "read-only"; running = true;
    await page.reload(); await page.getByRole("button", { name: "停止", exact: true }).waitFor();
    expect(await selector.isDisabled()).toBe(true);
    expect(await selectedText()).toBe("只读");
    await selector.locator('xpath=ancestor::div[contains(@class,"ant-select")][1]').hover();
    await page.getByRole("tooltip").getByText("本轮权限已固定，结束后可更改", { exact: true }).waitFor();
    await page.getByRole("textbox", { name: "给助手的消息" }).fill("继续分析");
    const supplemented = page.waitForResponse(response => response.url().endsWith("/assistant/steer"));
    await page.getByRole("button", { name: /^补\s*充$/ }).click(); await supplemented;
    expect(supplements.at(-1)?.permissionMode).toBeUndefined();
    activePermissionMode = undefined;
    await page.reload(); await page.getByRole("button", { name: "停止", exact: true }).waitFor();
    expect(await selectedText()).toBe("当前画布"); // Legacy active turns keep their original scope.
    expect(await selector.isDisabled()).toBe(true);
    running = false;
    await page.reload();
    await page.waitForFunction(() => !document.querySelector<HTMLInputElement>('input[aria-label="助手权限"]')?.disabled);
    expect(await selectedText()).toBe("完全访问");
    await page.evaluate(() => (window as any).assistantInputFixture.switchScope("other-workspace"));
    await page.waitForFunction(() => !document.querySelector<HTMLInputElement>('input[aria-label="助手权限"]')?.disabled);
    expect(await selectedText()).toBe("当前画布");
    await selector.click(); await page.locator('.ant-select-dropdown:visible .ant-select-item-option-content').getByText("只读", { exact: true }).click();
    await page.getByRole("textbox", { name: "给助手的消息" }).fill("只分析");
    const readonlySent = page.waitForResponse(response => response.url().endsWith("/assistant/chat"));
    await page.getByRole("button", { name: "发送", exact: true }).click(); await readonlySent;
    expect(chats.at(-1)?.permissionMode).toBe("read-only");
    await page.evaluate(() => (window as any).assistantInputFixture.switchScope("guest"));
    await page.waitForFunction(() => !document.querySelector<HTMLInputElement>('input[aria-label="助手权限"]')?.disabled);
    expect(await selectedText()).toBe("完全访问");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: "/tmp/beeftv-assistant-permissions-390.png" });
    await page.close();
}, 20000);

test("external Agent connection has no permission chooser and submits only the client kind", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(server.url.toString().replace("localhost", "127.0.0.1"));
    await page.getByRole("button", { name: "连接外部 Agent", exact: true }).click();
    const panel = page.locator(".agent-connect-panel");
    await panel.getByText("连接后可使用 BeefTV 的全部创作工具。每次操作的审批由 Codex 负责。", { exact: true }).waitFor();
    expect(await panel.getByRole("radio").count()).toBe(0);
    const connected = page.waitForResponse(response => response.url().endsWith("/agent-clients"));
    await panel.getByRole("button", { name: "生成连接配置", exact: true }).click(); await connected;
    expect(externalConnections.at(-1)).toEqual({ kind: "codex" });
    await panel.getByRole("status").filter({ hasText: "等待工具连接" }).waitFor();
    await page.screenshot({ path: "/tmp/beeftv-external-agent-connect.png" });
    await page.close();
}, 15000);

test("cross-canvas receipts report every target and one atomic undo refreshes all canvases only after success", async () => {
    running = false;
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(server.url.toString().replace("localhost", "127.0.0.1"));
    await page.waitForFunction(() => !document.querySelector<HTMLInputElement>('input[aria-label="助手权限"]')?.disabled);
    await page.getByRole("combobox", { name: "助手权限" }).click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option-content').getByText("完全访问", { exact: true }).click();
    await page.getByRole("textbox", { name: "给助手的消息" }).fill("改两个画布");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await page.getByText("修改了 2 个画布，新建 2 个节点，删除 1 个节点，删除 1 条线，修改时间线", { exact: true }).waitFor();
    await page.getByText("撤销会恢复这 2 个画布本轮的全部改动。", { exact: true }).waitFor();
    expect(await page.evaluate(() => (window as any).assistantInputFixture.changedCanvases())).toEqual(["input-canvas", "other-canvas"]);
    await page.getByRole("button", { name: "在画布上查看", exact: true }).click();
    expect(await page.evaluate(() => (window as any).assistantInputFixture.locatedNodes())).toEqual([["main-new"]]);
    const before = undoRequests.length;
    rejectNextUndo = true;
    await page.getByRole("button", { name: "撤销这一轮", exact: true }).click();
    await page.getByText("其中一个画布后来又改过，这一轮未撤销。", { exact: true }).waitFor();
    expect(undoRequests).toHaveLength(before + 1);
    expect(await page.evaluate(() => (window as any).assistantInputFixture.changedCanvases())).toEqual(["input-canvas", "other-canvas"]);
    await page.getByRole("button", { name: "撤销这一轮", exact: true }).click();
    await page.getByText("已撤销这一轮全部画布改动", { exact: true }).waitFor();
    expect(undoRequests).toHaveLength(before + 2);
    expect(undoRequests.at(-1)).toEqual({ canvasId: "input-canvas" });
    expect(await page.evaluate(() => (window as any).assistantInputFixture.changedCanvases())).toEqual(["input-canvas", "other-canvas", "input-canvas", "other-canvas"]);
    await page.screenshot({ path: "/tmp/beeftv-assistant-cross-canvas-undo.png" });
    await page.close();
}, 15000);

for (const mode of ["markdown", "zip"] as const) {
    test(`assistant installs ${mode} privately and sends the installed version pin`, async () => {
        running = false; installedSkills = [];
        const page = await browser.newPage();
        await page.goto(server.url.toString().replace("localhost", "127.0.0.1"));
        await page.getByRole("button", { name: "选择技能", exact: true }).click();
        await page.getByText("还没有已安装的技能。", { exact: true }).waitFor();
        await page.getByRole("button", { name: "安装技能", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "安装技能" });
        expect(await dialog.getByText("公开状态", { exact: true }).isVisible()).toBe(false);
        expect(await dialog.getByRole("button", { name: "从空白创建单文件技能" }).count()).toBe(0);
        if (mode === "zip") await dialog.getByText("ZIP 技能包", { exact: true }).click();
        await dialog.locator('input[type="file"]').setInputFiles({ name: mode === "zip" ? "coffee.zip" : "SKILL.md", mimeType: mode === "zip" ? "application/zip" : "text/markdown", buffer: Buffer.from("# Coffee review\nCheck the actual video.") });
        await dialog.getByRole("button", { name: "安装技能", exact: true }).click();
        await dialog.waitFor({ state: "hidden" });
        await page.getByRole("button", { name: "移除技能 咖啡审片", exact: true }).waitFor();
        await page.getByRole("button", { name: "咖啡审片 · 2.0", exact: true }).waitFor();
        expect(skillInstalls.at(-1)).toEqual({ sourceType: mode, isPrivate: "true", fileName: mode === "zip" ? "coffee.zip" : "SKILL.md" });
        await page.getByRole("textbox", { name: "给助手的消息" }).fill("请审查咖啡短片");
        const sent = page.waitForResponse(response => response.url().endsWith("/assistant/chat"));
        await page.getByRole("button", { name: "发送", exact: true }).click(); await sent;
        expect(chats.at(-1)?.skills).toEqual([{ skillId: "coffee", versionId: "coffee-v2", contentHash: "b".repeat(64) }]);
        await page.close();
    }, 20000);
}

test("an installation completing after an account switch cannot select a skill in the replacement draft", async () => {
    running = false; installedSkills = []; holdSkillInstall = true;
    const page = await browser.newPage();
    try {
        await page.goto(server.url.toString().replace("localhost", "127.0.0.1"));
        await page.getByRole("button", { name: "选择技能", exact: true }).click();
        await page.getByText("还没有已安装的技能。", { exact: true }).waitFor();
        await page.getByRole("button", { name: "安装技能", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "安装技能" });
        await dialog.locator('input[type="file"]').setInputFiles({ name: "SKILL.md", mimeType: "text/markdown", buffer: Buffer.from("# Coffee") });
        const held = page.waitForRequest(request => request.url().endsWith("/skills/install"));
        await dialog.getByRole("button", { name: "安装技能", exact: true }).click(); await held;
        await page.evaluate(() => (window as any).assistantInputFixture.switchScope("replacement"));
        await dialog.waitFor({ state: "hidden" });
        const completed = page.waitForResponse(response => response.url().endsWith("/skills/install"));
        releaseSkillInstall?.(); await completed;
        await page.getByRole("textbox", { name: "给助手的消息" }).fill("新账号的草稿");
        const sent = page.waitForResponse(response => response.url().endsWith("/assistant/chat"));
        await page.getByRole("button", { name: "发送", exact: true }).click(); await sent;
        expect(chats.at(-1)?.skills).toBeUndefined();
        expect(await page.getByRole("button", { name: "移除技能 咖啡审片" }).count()).toBe(0);
    } finally {
        holdSkillInstall = false; releaseSkillInstall?.(); releaseSkillInstall = null;
        await page.close();
    }
}, 20000);
