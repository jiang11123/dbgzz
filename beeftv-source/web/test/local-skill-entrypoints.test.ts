import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

describe("local skill entrypoints", () => {
    test("hides GitHub installation in the local runtime", () => {
        const source = readFileSync(resolve(root, "src/pages/skills/skill-install-modal.tsx"), "utf8");
        expect(source).toContain('import { isLocalRuntimeMode } from "@/lib/runtime-mode";');
        expect(source).toContain('modeOptions.filter((option) => option.value !== "github")');
    });

    test("does not offer GitHub sync from a local skill detail view", () => {
        const source = readFileSync(resolve(root, "src/pages/skills/skill-detail-drawer.tsx"), "utf8");
        expect(source).toContain("!localRuntime && skill.sourceType === \"github\"");
    });
});
