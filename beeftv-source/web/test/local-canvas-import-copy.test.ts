import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

const source = readFileSync(resolve(import.meta.dir, "../src/lib/canvas/canvas-archive-restore.ts"), "utf8");

describe("local canvas import progress copy", () => {
    test("does not present local media persistence as a cloud upload", () => {
        expect(source).toContain('message: localPersistence ? "正在保存本地媒体" : "正在上传媒体"');
        expect(source).toContain('phase: localPersistence ? "saving" : "uploading"');
        expect(source).not.toContain('phase: "uploading",\n                        message: "正在上传媒体至云端",');
    });
});
