import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { distributionNotices } from "./distribution-notices.mjs";

function fixture(t) {
    const root = mkdtempSync(resolve(tmpdir(), "beeftv-notices-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    for (const name of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md", "licenses/GPL-2.0.txt", "licenses/GPL-3.0.txt", "licenses/LGPL-2.1.txt",
        "web/node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm", "web/node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js"]) {
        mkdirSync(resolve(root, name, ".."), { recursive: true });
        writeFileSync(resolve(root, name), name);
    }
    writeFileSync(resolve(root, "web/node_modules/@ffmpeg/core/package.json"), JSON.stringify({ version: "0.12.10", license: "GPL-2.0-or-later" }));
    writeFileSync(resolve(root, "licenses/ffmpeg-windows.json"), readFileSync(new URL("../licenses/ffmpeg-windows.json", import.meta.url)));
    return root;
}

test("every platform includes offline texts without inventing source downloads", (t) => {
    const root = fixture(t);
    for (const platform of ["web", "darwin-arm64", "darwin-amd64", "windows-amd64", "linux-amd64"]) {
        const files = distributionNotices({ root, version: "1.7.28", platform });
        const index = JSON.parse(files.get("sources.json"));
        assert.equal(index.version, "v1.7.28");
        assert.ok(index.components.every((c) => c.source === null && c.upstream.startsWith("https://")));
        assert.equal(index.components[0].binaryHashes.wasm, createHash("sha256").update("web/node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm").digest("hex"));
        for (const name of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md", "GPL-2.0.txt", "GPL-3.0.txt", "LGPL-2.1.txt"]) assert.ok(files.get(name)?.length);
        assert.doesNotMatch(files.get("index.html").toString(), /releases\/download|href="sources\//);
    }
});

test("Windows notices use the packager's pinned build and source artifact receipt", (t) => {
    const root = fixture(t);
    const lock = JSON.parse(readFileSync(resolve(root, "licenses/ffmpeg-windows.json"), "utf8"));
    const files = distributionNotices({ root, version: "v1.7.28", platform: "windows-amd64" });
    const component = JSON.parse(files.get("sources.json")).components.find((c) => c.id === "ffmpeg-windows-amd64");
    assert.equal(component.version, lock.runtimeVersion);
    assert.deepEqual(component.binaryHashes, { ffmpeg: lock.binarySHA256, ffprobe: lock.probeSHA256 });
    assert.deepEqual(component.sourceArtifacts, lock.sourceArtifacts);
    assert.deepEqual(JSON.parse(files.get("ffmpeg-windows.json")), lock);
    assert.equal(component.source, null);
    assert.equal(component.upstream, lock.buildRecipe);
    assert.equal(component.sourceRelease, lock.sourceRelease);
    assert.ok(files.get("index.html").toString().includes(lock.sourceRelease));
});

test("macOS source download names and hashes match the generated packet", (t) => {
    const root = fixture(t);
    mkdirSync(resolve(root, "dist"));
    const name = "BeefTV-v1.7.28-ffprobe-darwin-arm64-sources.tar.gz";
    writeFileSync(resolve(root, "dist", name), "source-packet");
    const files = distributionNotices({ root, version: "v1.7.28", platform: "darwin-arm64" });
    const source = JSON.parse(files.get("sources.json")).components[1].source;
    assert.equal(source.name, name);
    assert.equal(source.size, 13);
    assert.equal(source.sha256, createHash("sha256").update("source-packet").digest("hex"));
    assert.ok(source.url.endsWith(`/v1.7.28/${name}`));
    assert.ok(files.get("index.html").toString().includes(source.url));
});

test("WASM source links require the matching published core", (t) => {
    const root = fixture(t);
    const binaryHashes = JSON.parse(distributionNotices({ root, version: "v1.7.27" }).get("sources.json")).components[0].binaryHashes;
    writeFileSync(resolve(root, "licenses/ffmpeg-wasm-sources.json"), JSON.stringify({ version: "0.12.10", binaryHashes }));
    mkdirSync(resolve(root, "dist"));
    const name = "BeefTV-v1.7.27-ffmpeg-wasm-sources.tar.gz";
    writeFileSync(resolve(root, "dist", name), "source-packet");
    const files = distributionNotices({ root, version: "v1.7.27" });
    assert.equal(JSON.parse(files.get("sources.json")).components[0].source.name, name);
    assert.ok(files.get("index.html").toString().includes(name));
    writeFileSync(resolve(root, "web/node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm"), "changed core");
    assert.throws(() => distributionNotices({ root, version: "v1.7.27" }), /does not match/);
});

test("slim builds omit WASM and invalid inputs fail before producing notices", (t) => {
    const root = fixture(t);
    const files = distributionNotices({ root, version: "v1.7.28", heavyMedia: false });
    assert.deepEqual(JSON.parse(files.get("sources.json")).components, []);
    assert.throws(() => distributionNotices({ root, version: '<script>' }), /version/);
    assert.throws(() => distributionNotices({ root, version: 'v1.7.28', platform: '../bad' }), /platform/);
    writeFileSync(resolve(root, "web/node_modules/@ffmpeg/core/package.json"), JSON.stringify({ version: "0.99.0", license: "GPL-2.0-or-later" }));
    assert.throws(() => distributionNotices({ root, version: 'v1.7.28' }), /third-party notice/);
});

test("external links use the desktop browser bridge but retain normal browser navigation", (t) => {
    const root = fixture(t);
    const html = distributionNotices({ root, version: "v1.7.28" }).get("index.html").toString();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    for (const mode of ["iframe-runtime", "parent-runtime", "both-runtime", "browser", "cross-origin-browser"]) {
        const opened = [];
        const runtime = { BrowserOpenURL(url) { opened.push(url); } };
        const window = { parent: {} };
        if (mode === "iframe-runtime") window.runtime = runtime;
        if (mode === "parent-runtime") window.parent.runtime = runtime;
        if (mode === "both-runtime") {
            // Wails injects its runtime into HTML iframes, but macOS rejects
            // their native messages. Only the main frame may open the browser.
            window.runtime = { BrowserOpenURL() { throw Error("Blocked request from not main frame"); } };
            window.parent.runtime = runtime;
        }
        if (mode === "cross-origin-browser") Object.defineProperty(window, "parent", { get() { throw Error("cross origin"); } });
        let click;
        runInNewContext(script, { window, document: { addEventListener(name, handler) { assert.equal(name, "click"); click = handler; } } });
        let prevented = false;
        const href = "https://github.com/glanderness/BeefTV/releases/download/v1.7.28/source.tar.gz";
        click({ target: { closest() { return { href }; } }, preventDefault() { prevented = true; } });
        const desktop = mode.endsWith("runtime");
        assert.equal(prevented, desktop);
        assert.deepEqual(opened, desktop ? [href] : []);
        click({ target: { closest() { return null; } }, preventDefault() { throw Error("Intercepted a local license link"); } });
    }
});
