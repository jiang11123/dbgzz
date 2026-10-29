import { describe, expect, test } from "bun:test";

import { syncBeforeUnloadMessage, type SyncProjectProgress } from "../src/stores/use-sync-progress-store";

const progress: SyncProjectProgress[] = [{ projectId: "project-1", total: 1, completed: 0, phase: "saving", message: "正在保存" }];

describe("sync progress local boundary", () => {
    test("uses the runtime mode instead of parsing an intermediate message", () => {
        expect(syncBeforeUnloadMessage(progress, true)).toBe("画布正在保存到本地，请勿关闭页面。");
        expect(syncBeforeUnloadMessage(progress, false)).toBe("画布正在同步至云端，请勿关闭页面。");
    });

    test("does not warn when no project is actively saving", () => {
        expect(syncBeforeUnloadMessage([], true)).toBe("");
    });
});
