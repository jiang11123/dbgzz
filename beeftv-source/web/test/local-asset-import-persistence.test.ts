import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

const source = readFileSync(resolve(import.meta.dir, "../src/pages/assets/index.tsx"), "utf8");

describe("local asset package import", () => {
    test("flushes imported assets before reporting success", () => {
        const importBlock = source.slice(source.indexOf("const importAssetZip"), source.indexOf("const restoreAsset"));
        expect(importBlock).toContain("await flushAssetStorePersistence(scope)");
        expect(importBlock.indexOf("await flushAssetStorePersistence(scope)")).toBeGreaterThan(importBlock.indexOf("addAsset(payload"));
        expect(importBlock).toContain("素材已在本地导入");
    });
});
