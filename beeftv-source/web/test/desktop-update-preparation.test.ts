import { expect, test } from "bun:test";
import { assertDesktopUpdateProgressSettled, DesktopUpdateSaveInProgressError, hasActiveDesktopEditorSaves, prepareDesktopEditorsForUpdate, registerDesktopUpdatePreparation } from "../src/services/desktop-update-preparation";
import { canvasSyncProgressKey, type SyncProjectProgress } from "../src/stores/use-sync-progress-store";

test("unmounting an editor does not hide IO already in progress", () => {
    let writing = true;
    const unregister = registerDesktopUpdatePreparation(() => {}, () => writing);
    expect(hasActiveDesktopEditorSaves()).toBe(true);
    unregister();
    expect(hasActiveDesktopEditorSaves()).toBe(true);
    writing = false;
    expect(hasActiveDesktopEditorSaves()).toBe(false);
});

test("historical errors for removed projects and other accounts do not block an idle update", () => {
    const records: Record<string, SyncProjectProgress> = {
        [canvasSyncProgressKey("deleted", "current")]: {projectId: "deleted", phase: "error", total: 1, completed: 0},
        [canvasSyncProgressKey("foreign", "other")]: {projectId: "foreign", phase: "saving", total: 1, completed: 0},
    };
    expect(() => assertDesktopUpdateProgressSettled(records, new Set(), "current")).not.toThrow();
});

test("ongoing writes always block, while failed saves require an explicit override", () => {
    for (const phase of ["pending", "uploading", "saving", "error", "conflict", "done"] as const) {
        const records = {[canvasSyncProgressKey("canvas", "current")]: {projectId: "canvas", phase, total: 1, completed: 0}};
        const check = (allowFailed = false) => assertDesktopUpdateProgressSettled(records, new Set(["canvas"]), "current", allowFailed);
        if (["pending", "uploading", "saving"].includes(phase)) {
            expect(() => check()).toThrow(DesktopUpdateSaveInProgressError);
            expect(() => check(true)).toThrow(DesktopUpdateSaveInProgressError);
        } else if (phase === "error" || phase === "conflict") {
            expect(() => check()).toThrow("保存失败或存在内容冲突");
            expect(() => check(true)).not.toThrow();
        } else expect(() => check()).not.toThrow();
    }
});

test("restart preparation waits for mounted editor persistence", async () => {
    let complete!: () => void;
    let saved = false;
    let prepared = false;
    const unregister = registerDesktopUpdatePreparation(async () => {
        await new Promise<void>((resolve) => {
            complete = resolve;
        });
        saved = true;
    });
    try {
        const pending = prepareDesktopEditorsForUpdate().then(() => {
            prepared = true;
        });
        await Promise.resolve();
        expect(prepared).toBe(false);
        complete();
        await pending;
        expect(saved).toBe(true);
        expect(prepared).toBe(true);
    } finally {
        unregister();
    }
});

test("failed editor save blocks restart and remains retryable", async () => {
    let fails = true;
    const unregister = registerDesktopUpdatePreparation(async () => {
        if (fails) throw new Error("save failed");
    });
    try {
        await expect(prepareDesktopEditorsForUpdate()).rejects.toThrow("save failed");
        fails = false;
        await prepareDesktopEditorsForUpdate();
    } finally {
        unregister();
    }
});

test("unmounted workspace callbacks no longer block another workspace", async () => {
    const unregister = registerDesktopUpdatePreparation(() => {
        throw new Error("stale workspace");
    });
    unregister();
    await prepareDesktopEditorsForUpdate();
});
