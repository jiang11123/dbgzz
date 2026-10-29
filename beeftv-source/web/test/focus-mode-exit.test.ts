import { expect, test } from "bun:test";

const source = await Bun.file(new URL("../src/hooks/use-focus-mode.ts", import.meta.url)).text();

test("退出专注模式后不能被小屏自动策略立即重新打开", () => {
    expect(source).toContain("const focusMode = userPreference;");
    expect(source).not.toContain("const focusMode = smallScreen || userPreference;");
});
