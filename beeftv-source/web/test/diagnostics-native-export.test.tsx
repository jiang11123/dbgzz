import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { downloadDiagnosticBundle } from "@/services/diagnostics/diagnostics-api";

const originalWindow = globalThis.window;
afterEach(() => { globalThis.window = originalWindow; });

test("the existing diagnostic URL passes its task and canvas to the modal", () => {
    const settings = readFileSync(new URL("../src/pages/settings/index.tsx", import.meta.url), "utf8");
    expect(settings).toContain('open={activeTab === "diagnostics"}');
    expect(settings).toContain('taskId={searchParams.get("taskId") || undefined}');
    expect(settings).toContain('projectId={searchParams.get("projectId") || undefined}');
    expect(settings).toContain('onClose={() => selectSection("channels")}');
});

test("native diagnostic ZIP bytes reach the chosen-file binding and cancellation is preserved", async () => {
    const calls: Array<[string, string]> = [];
    Object.assign(globalThis, { window: { location: { protocol: "wails:" }, go: { main: { DesktopApp: { SaveOwnedArtifact: async (name: string, bytes: string) => { calls.push([name, bytes]); return false; } } } } } });
    const data = new Uint8Array([80, 75, 3, 4, 0, 255]);
    const result = await downloadDiagnosticBundle({ blob: new Blob([data], { type: "application/zip" }), fileName: "beeftv-diagnostics.zip", bundleId: "DIAG_TEST" });
    expect(result).toBe("cancelled");
    expect(calls.length).toBe(1);
    expect(calls[0][0]).toBe("beeftv-diagnostics.zip");
    expect(new Uint8Array(Buffer.from(calls[0][1], "base64"))).toEqual(data);
});
