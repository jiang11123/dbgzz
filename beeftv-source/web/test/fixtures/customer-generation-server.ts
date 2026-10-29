import { customerGenerationProject, type CustomerGenerationScenario } from "./customer-generation-scenarios";

const contexts = new Map<string, { project: ReturnType<typeof customerGenerationProject>; posts: any[]; downloads: string[]; lookups: string[]; task?: any; holdCharacter?: boolean; delayReceipt?: boolean; sameOriginHang?: boolean; release: () => void; gate: Promise<void> }>();
const json = (data: unknown) => Response.json({ code: 0, data, msg: "ok" });
// Valid 2.5 second PCM file so the browser, rather than a duration stub, probes it.
function audioWav() {
    const samples = 8000 * 2.5;
    const bytes = new Uint8Array(44 + samples * 2);
    const view = new DataView(bytes.buffer);
    const text = (offset: number, value: string) => [...value].forEach((letter, index) => view.setUint8(offset + index, letter.charCodeAt(0)));
    text(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); text(8, "WAVEfmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, 8000, true); view.setUint32(28, 16000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, samples * 2, true);
    return bytes;
}

export async function startCustomerScenarioServer(options: { port?: number } = {}) {
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/customer-generation-harness.tsx"], target: "browser", define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false", "import.meta.env.PROD": "true", "import.meta.env.MODE": '"production"', "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"true"', "import.meta.env.VITE_CANVAS_BACKEND_URL": '"/api"' }, plugins: [{ name: "source", setup(builder) {
        builder.onResolve({ filter: /^@\// }, args => ({ path: Bun.resolveSync("../../src/" + args.path.slice(2), import.meta.dir) }));
        builder.onLoad({ filter: /\.(css|svg|png|jpe?g|gif|webp|woff2?)$/ }, () => ({ contents: "export default ''", loader: "js" }));
    } }] });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0]!.text();
    // Hold media on another origin. Holding every HTTP/1 connection to the API
    // would also stall task POSTs before they reach the application, masking the
    // cache-scheduler dependency that this fixture is intended to exercise.
    const mediaServer = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 255, async fetch(request) {
        const id = new URL(request.url).searchParams.get("case") || "";
        const state = contexts.get(id);
        if (!state) return new Response("unknown scenario", { status: 404 });
        await state.gate;
        return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>', { headers: {
            "Content-Type": "image/svg+xml", "Access-Control-Allow-Origin": request.headers.get("origin") || "null", "Access-Control-Allow-Credentials": "true",
        } });
    } });
    const server = Bun.serve({ hostname: "127.0.0.1", port: options.port || 0, idleTimeout: 255, async fetch(request) {
        const url = new URL(request.url);
        const cookie = request.headers.get("cookie") || "";
        const id = url.searchParams.get("case") || cookie.match(/scenario=([^;]+)/)?.[1] || "";
        const state = contexts.get(id);
        if (url.pathname === "/harness.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
        if (!state) return new Response("unknown scenario", { status: 404 });
        if (url.pathname === "/_scenario/state") return json({ project: state.project, posts: state.posts, downloads: state.downloads, lookups: state.lookups });
        if (url.pathname === "/_scenario/release") { state.release(); return json({ released: true }); }
        if (url.pathname === "/") { state.holdCharacter = url.searchParams.has("hold-character"); state.delayReceipt = url.searchParams.has("lose-receipt"); state.sameOriginHang = url.searchParams.has("same-origin-hang"); }
        if (url.pathname === "/api/ops/canvas.document.commit") {
            const body = await request.json();
            state.project = { ...body.params.document, revision: state.project.revision + 1 };
            return json({ revision: state.project.revision, result: { canvasId: state.project.id, revision: state.project.revision, title: state.project.title, updatedAt: state.project.updatedAt } });
        }
        if (url.pathname === `/api/canvas-projects/${state.project.id}`) return json({ project: state.project });
        if (url.pathname === "/api/tasks" && request.method === "POST") {
            const body = await request.json();
            state.posts.push(body);
            // Match taskForOutput/publicTaskInputJSON: recovery receives mode
            // and metadata while credentials and binary references are omitted.
            state.task ||= { id: "original-customer-task", projectId: body.projectId, type: body.type, prompt: body.prompt, clientOperationId: body.input?.metadata?.clientOperationId, status: "running", stage: "供应商处理中", progress: 10, attempts: 1, createdAt: "2026-10-17T00:00:00Z", updatedAt: "2026-10-17T00:00:00Z", inputJson: JSON.stringify({ mode: body.input.mode, metadata: body.input.metadata }) };
            if (state.delayReceipt) await new Promise(resolve => setTimeout(resolve, 6000));
            return json(state.task);
        }
        if (url.pathname.startsWith("/api/tasks/by-operation/")) { state.lookups.push(url.pathname); return state.task ? json(state.task) : Response.json({ code: 404, msg: "not found", reason: "task_not_found" }, { status: 404 }); }
        if (url.pathname === "/api/tasks") return json(state.task ? [state.task] : []);
        if (url.pathname === "/api/tasks/original-customer-task") return json(state.task);
        if (url.pathname === "/api/projects/synthetic-domain/characters/character-asset") { if (state.holdCharacter) await state.gate; return json({ asset: { id: "character-asset", title: "测试角色" }, character: { versionId: "character-v1", definition: { appearance: "synthetic" }, representations: [{ resourceId: "character-image", role: "primary" }] } }); }
        const resource = url.pathname.match(/^\/api\/resources\/([^/]+)(\/file)?$/);
        if (resource) {
            const name = resource[1]!;
            if (resource[2]) {
                state.downloads.push(name);
                if (name.startsWith("blocker-")) {
                    if (state.sameOriginHang) await state.gate;
                    else return new Response(null, { status: 302, headers: { Location: `${mediaServer.url}?case=${id}` } });
                }
                if (name === "audio-1") return new Response(audioWav(), { headers: { "Content-Type": "audio/wav" } });
                return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="blue"/></svg>', { headers: { "Content-Type": "image/svg+xml" } });
            }
            return json({ resource: { id: name, status: "ready", userId: "synthetic-customer", kind: name === "audio-1" ? "audio" : "image", mimeType: name === "audio-1" ? "audio/wav" : "image/svg+xml", durationMs: name === "audio-1" ? 0 : 2500, width: 1280, height: 720, size: 128, objectKey: name } });
        }
        if (url.pathname.startsWith("/api/")) return json([]);
        return new Response('<meta charset="utf-8"><div id="root"></div><script>window.__customerProject=' + JSON.stringify(state.project).replaceAll("<", "\\u003c") + '</script><script type="module" src="/harness.js"></script>', { headers: { "Content-Type": "text/html; charset=utf-8", "Set-Cookie": `scenario=${id}; Path=/; SameSite=Lax` } });
    } });
    return { server, contexts, stop() { for (const state of contexts.values()) state.release(); server.stop(true); mediaServer.stop(true); }, create(scenario: CustomerGenerationScenario) {
        const id = crypto.randomUUID();
        let release!: () => void;
        const state = { project: customerGenerationProject(scenario), posts: [] as any[], downloads: [] as string[], lookups: [] as string[], gate: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
        contexts.set(id, state);
        return { id, state, url: `${server.url}?case=${id}&scenario=${scenario}` };
    } };
}

if (import.meta.main) {
    const runtime = await startCustomerScenarioServer({ port: Number(process.env.BEEFTV_SCENARIO_PORT || "4089") });
    for (const scenario of ["five-images", "video-image", "missing-audio-duration", "character"] as const) {
        const entry = runtime.create(scenario);
        console.log(JSON.stringify({ scenario, url: entry.url }));
    }
}
