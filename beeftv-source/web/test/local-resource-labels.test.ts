import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

describe("local resource labels", () => {
    test("does not classify local Go resources as cloud storage", () => {
        const source = readFileSync(resolve(root, "src/lib/canvas/resource-storage-status.ts"), "utf8");
        expect(source).toContain('import { isLocalRuntimeMode } from "@/lib/runtime-mode";');
        expect(source).toContain("storageKey.startsWith(\"resource:\") ? (localRuntime ? \"local\" : \"oss\") : \"local\"");
        expect(source).toContain("保存在本机资源目录，不会上传到云端");
    });

    test("only shows the legacy remote-upload warning in hosted mode", () => {
        const source = readFileSync(resolve(root, "src/pages/canvas/use-canvas-upload.ts"), "utf8");
        expect(source).toContain("const browserFallback = Boolean(metadata.storageKey && !resourceIdFromStorageKey(metadata.storageKey));");
        expect(source).toContain("const localOnly = browserFallback && localRuntime;");
        expect(source).toContain("const remotePending = browserFallback && !localRuntime;");
        expect(source).toContain("已保存在本机缓存，资源服务暂不可用");
    });

    test("canvas text uploads use the same local-first media boundary", () => {
        const source = readFileSync(resolve(root, "src/pages/canvas/use-canvas-upload.ts"), "utf8");
        expect(source).toContain('const uploaded = await uploadMediaFile(file, "file", onProgress, guard.expectedScope);');
        expect(source).toContain("storageKey: uploaded.storageKey");
        expect(source).not.toContain('uploadResourceFile(file, "file"');
    });
});
