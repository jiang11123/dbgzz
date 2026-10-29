import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("local new canvas waits for local-store hydration but not browser session hydration", () => {
    const source = readFileSync(resolve(import.meta.dir, "../src/pages/canvas/index.tsx"), "utf8");
    expect(source).toContain("if (!hydrated || (remoteMode && (!sessionHydrated || !libraryQuery.isSuccess))");
    expect(source).not.toContain("if (!hydrated || !sessionHydrated ||");
});

test("local canvas editor lifecycle does not disable persistence while browser stores hydrate", () => {
    const source = readFileSync(resolve(import.meta.dir, "../src/pages/canvas/use-canvas-project-lifecycle.ts"), "utf8");
    expect(source).toContain("if (!localMode && (!hydrated || !sessionHydrated)) return;");
    expect(source).not.toContain("if (!hydrated || !sessionHydrated) return;");
});
