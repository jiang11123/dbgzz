import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const runtime = readFileSync(resolve(import.meta.dir, "../src/lib/runtime-mode.ts"), "utf8");
const imageStorage = readFileSync(resolve(import.meta.dir, "../src/services/image-storage.ts"), "utf8");
const fileStorage = readFileSync(resolve(import.meta.dir, "../src/services/file-storage.ts"), "utf8");
const resourceStorageMode = readFileSync(resolve(import.meta.dir, "../src/services/workspace-resource-storage.ts"), "utf8");

test("native local mode uses the Go resource store with browser fallback", () => {
    expect(runtime).toContain("isNativeDesktopRuntime");
    expect(runtime).toContain("127\\.0\\.0\\.1");
    expect(resourceStorageMode).toContain("usesNativeLocalResourceStore");
    for (const source of [imageStorage, fileStorage]) {
        expect(source).toContain("usesBrowserLocalResourceStore");
        expect(source).toContain("uploadResourceFile");
        expect(source).toContain("pendingRemoteUpload: true");
    }
});
