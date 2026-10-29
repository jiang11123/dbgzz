import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("legacy inline image assets are promoted before canvas insertion", () => {
    const source = readFileSync(resolve(import.meta.dir, "../src/pages/canvas/use-canvas-upload.ts"), "utf8");
    expect(source).toContain('if (content.startsWith("data:image/") || !resourceIdFromStorageKey(storageKey || ""))');
    expect(source).toContain("const uploaded = await uploadImage(content, undefined, guard.expectedScope)");
    expect(source).toContain("storageKey = uploaded.storageKey");
    expect(source).toContain("storageKey,");
    expect(source).toContain('await http.put(`/assets/${encodeURIComponent(asset.id)}`');
});

test("Wails protocol is an authoritative native desktop signal", () => {
    const source = readFileSync(resolve(import.meta.dir, "../src/lib/runtime-mode.ts"), "utf8");
    expect(source).toContain('window.location?.protocol === "wails:"');
});
