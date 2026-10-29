import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

const source = readFileSync(resolve(import.meta.dir, "../src/components/canvas/canvas-project-card.tsx"), "utf8");

describe("local project progress copy", () => {
    test("distinguishes local persistence from remote synchronization", () => {
        expect(source).toContain('syncProgress?.message?.includes("本地")');
        expect(source).toContain('{isLocalSave ? "本地保存中" : "云端同步中"}');
        expect(source).toContain('{isLocalSave ? "媒体保存" : "媒体上传"}');
    });
});
