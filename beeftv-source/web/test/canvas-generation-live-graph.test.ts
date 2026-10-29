import { expect, test } from "bun:test";

test("delayed second regeneration uses live graph while retaining confirmed billing inputs", async () => {
    const child = Bun.spawn([process.execPath, "run", "test/fixtures/generation-live-graph.fixture.ts"], { cwd: import.meta.dir + "/..", stdout: "pipe", stderr: "pipe" });
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
    expect(stdout).toContain("PASS: shared frozen inputs");
}, 15000);
