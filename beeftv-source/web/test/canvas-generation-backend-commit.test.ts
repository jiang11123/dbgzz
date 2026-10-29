import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("completed generation effects persist through the ordinary canvas operations path", () => {
    const source = readFileSync(resolve(import.meta.dir, "../src/services/canvas-generation-consumer.ts"), "utf8");
    expect(source).toContain("await persistCanvasDocument(input.projectId, { nodes }, capturedScope);");
    expect(source).not.toContain("syncLocalCanvasGenerationProjectToBackend");
    expect(source).not.toContain("persistCanvasGenerationEffect");
    expect(source).not.toContain("generated-assets");
});
