// Local, zero-model browser fixture. Start with `bun scripts/serve-light-references-test.mjs`.
// Use the printed URL in a browser, block the cache, then prepare references and composites.
import { createServer } from "vite";

const uploaded = new Map();
const held = new Set();
let blobReads = 0;
const json = (response, data) => { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(data)); };
const server = await createServer({ server: { host: "127.0.0.1", port: 0, cors: { origin: /^http:\/\/(?:localhost|127\.0\.0\.1):\d+$/, credentials: true } }, plugins: [{
    name: "light-references-fixture",
    configureServer(vite) {
        vite.middlewares.use(async (request, response, next) => {
            response.setHeader("Access-Control-Allow-Origin", request.headers.origin || "*");
            response.setHeader("Access-Control-Allow-Credentials", "true");
            response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Desktop-Token");
            if (request.method === "OPTIONS") { response.end(); return; }
            const path = new URL(request.url, "http://fixture").pathname;
            if (path === "/__light_references") {
                response.setHeader("Content-Type", "text/html; charset=utf-8");
                response.end(await vite.transformIndexHtml(path, '<html><body><button id="block-cache">占满预览下载队列</button><button id="prepare-references">准备已有图片和角色</button><button id="prepare-derived">准备绘图和调色</button><pre id="status">等待测试</pre><script type="module" src="/test/fixtures/canvas-generation-light-references.fixture.ts"></script></body></html>')); return;
            }
            if (path === "/__light_references/state") return json(response, { blocked: held.size, uploads: uploaded.size, blobReads });
            if (/^\/api\/resources\/blocked-\d+\/file$/.test(path)) { held.add(response); response.on("close", () => held.delete(response)); return; }
            if (path === "/api/projects/project/characters/character") return json(response, { code: 0, msg: "ok", data: { asset: { id: "character", title: "禾禾" }, character: { versionId: "v2", definition: {}, representations: [{ id: "main", resourceId: "character-main", role: "primary" }, { id: "side", resourceId: "character-side", role: "side" }] } } });
            if (path === "/api/resources" && request.method === "POST") {
                const chunks = []; for await (const chunk of request) chunks.push(chunk);
                const form = await new Request("http://fixture", { method: "POST", headers: request.headers, body: Buffer.concat(chunks) }).formData();
                const file = form.get("file"); const id = `upload-${uploaded.size + 1}`;
                uploaded.set(id, Buffer.from(await file.arrayBuffer()));
                return json(response, { code: 0, msg: "ok", data: { resource: { id, kind: "image", status: "ready", mimeType: "image/png", publicUrl: `http://${request.headers.host}/__light_references/uploads/${id}`, objectKey: id, size: file.size } } });
            }
            if (path.startsWith("/__light_references/uploads/")) { response.setHeader("Content-Type", "image/png"); response.end(uploaded.get(path.split("/").at(-1))); return; }
            if (/^\/api\/resources\/[^/]+\/file$/.test(path) || path === "/__light_references/remote.png") { blobReads++; response.statusCode = 500; response.end("Unexpected preview blob read"); return; }
            next();
        });
    },
}] });
await server.listen();
console.log(`LIGHT_REFERENCES_URL=http://127.0.0.1:${server.httpServer.address().port}/__light_references`);
const close = async () => { for (const response of held) response.destroy(); await server.close(); process.exit(0); };
process.on("SIGTERM", close); process.on("SIGINT", close);
