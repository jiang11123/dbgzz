import { expect, test } from "bun:test";

const repository = await Bun.file(new URL("../src/services/local-workspace-repository.ts", import.meta.url)).text();

test("local workspace repository stays independent from remote sync", () => {
    expect(repository).toContain("createLocalCanvasProject");
    expect(repository).toContain("openLocalCanvasProject");
    expect(repository).toContain("flushLocalWorkspace");
    expect(repository).toContain("flushCanvasStorePersistence");
    expect(repository).not.toContain("fetch(");
    expect(repository).not.toContain("api/user");
});

test("local canvas creation does not block navigation on a persistence failure", () => {
    expect(repository).toContain("void flushCanvasStorePersistence().catch");
});
