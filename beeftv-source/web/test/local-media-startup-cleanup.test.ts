import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(import.meta.dir, "../src/components/layout/client-root-init.tsx"), "utf8");

test("local startup cleans only after both workspace stores hydrate", () => {
    expect(source).toContain("assetsHydrated");
    expect(source).toContain("canvasHydrated");
    expect(source).toContain("useAssetStore.getState().cleanupImages()");
    expect(source).toContain("if (!localMode || !assetsHydrated || !canvasHydrated) return;");
    expect(source).toContain("本地媒体缓存清理失败");
});
