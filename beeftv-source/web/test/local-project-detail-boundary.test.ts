import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/pages/projects/detail.tsx", import.meta.url), "utf8");

test("project detail creates canvases through the central local workspace boundary", () => {
    expect(source).toContain('import { isLocalWorkspaceMode } from "@/services/workspace-mode";');
    expect(source).toContain("if (isLocalWorkspaceMode()) {");
    expect(source).not.toContain('if (import.meta.env.VITE_CANVAS_LOCAL_MODE !== "false")');
});
