import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

// Keep module mocks isolated from the real native/wasm fixture test.
test("export runtime failure and cancellation contracts (isolated unit doubles)", () => {
    const result = spawnSync(process.execPath, ["test", "./test/fixtures/timeline-export-runtime.fixture.ts"], { cwd: process.cwd(), encoding: "utf8" });
    expect(result.stdout + result.stderr).toContain("0 fail");
    expect(result.status).toBe(0);
});
