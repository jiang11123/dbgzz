import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

const storageStatus = readFileSync(resolve(import.meta.dir, "../src/lib/canvas/resource-storage-status.ts"), "utf8");
const versionHistory = readFileSync(resolve(import.meta.dir, "../src/pages/canvas/canvas-version-history.tsx"), "utf8");

describe("local resource copy", () => {
    test("local-only UI describes a local resource boundary without cloud wording", () => {
        expect(storageStatus).toContain('localRuntime ? "仅保存在本机资源库"');
        expect(versionHistory).toContain("本机草稿");
        expect(versionHistory).toContain("本机备份");
    });
});
