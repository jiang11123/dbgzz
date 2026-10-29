import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

const source = readFileSync(resolve(import.meta.dir, "../src/stores/use-sync-progress-store.ts"), "utf8");

describe("local sync unload warning", () => {
    test("uses local wording when all active progress entries are local", () => {
        expect(source).toContain('const localOnly = progress.every((item) => item.message?.includes("本地"));');
        expect(source).toContain('localOnly ? "画布正在保存到本地，请勿关闭页面。" : "画布正在同步至云端，请勿关闭页面。"');
    });
});
