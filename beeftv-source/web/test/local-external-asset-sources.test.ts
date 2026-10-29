import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/hooks/use-external-asset-sources.ts", import.meta.url), "utf8");

test("local asset pickers do not enumerate or write external plugin sources", () => {
    expect(source).toContain("const localMode = isLocalWorkspaceMode();");
    expect(source).toContain("localMode ? [] : createHostedAssetSources");
    expect(source).toContain('throw new Error("本地工作区仅支持本地素材")');
});
