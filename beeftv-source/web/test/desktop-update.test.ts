import { afterEach, describe, expect, spyOn, test } from "bun:test";

import type { DesktopRuntimeBinding, DesktopUpdateState } from "@/services/desktop-runtime";
import { flushCanvasStorePersistence, withCanvasStorePersistenceLock } from "@/stores/canvas/use-canvas-store";
import { flushAssetStorePersistence } from "@/stores/use-asset-store";
import * as modelConfig from "@/services/model-config-repository";
import { withGenerationArtifactCommitLock, withGenerationAssetStorageLock } from "@/services/generation-asset-repository";
import { DesktopUpdateSaveInProgressError, prepareDesktopEditorsForUpdate, registerDesktopUpdatePreparation } from "@/services/desktop-update-preparation";
import {
    createDesktopUpdateController,
    persistWorkspaceBeforeDesktopInstall,
    desktopUpdateActionLabel,
    desktopUpdateProgressPercent,
    desktopUpdateDetailLabel,
    desktopUpdateProgressLabel,
    formatDesktopUpdateRemaining,
    hasResumableDesktopUpdate,
    formatDesktopVersionLabel,
    hasDesktopUpdateBinding,
    parseDesktopUpdateState,
    resetSharedDesktopUpdateController,
    shouldShowDesktopUpdaterControls,
    userFacingDesktopUpdateError,
    type DesktopUpdateSnapshot,
} from "@/services/desktop-update";

afterEach(() => {
    resetSharedDesktopUpdateController();
});

test("model config writes that resolve with an error state still refuse ordinary installation", async () => {
    const flush = spyOn(modelConfig, "flushModelConfig").mockResolvedValue(undefined);
    const state = spyOn(modelConfig, "getModelConfigPersistenceState").mockReturnValue({ status: "error", dirty: true, revision: 1, error: "disk failed" });
    try {
        await expect(persistWorkspaceBeforeDesktopInstall()).rejects.toThrow("模型配置尚未保存完成");
    } finally { flush.mockRestore(); state.mockRestore(); }
});

test("the real force guard refuses pending canvas and generation IO even without progress records", async () => {
    await Promise.all([flushCanvasStorePersistence(), flushAssetStorePersistence()]);
    for (const lock of [withCanvasStorePersistenceLock, withGenerationAssetStorageLock, withGenerationArtifactCommitLock]) {
        const mock = mockBinding(state({ status: "ready", latestVersion: "v1.5.2" }));
        const controller = createDesktopUpdateController({
            getBinding: () => mock.binding, isDesktopRuntime: () => true,
            persistWorkspace: async () => { throw new Error("保存失败"); },
            scheduler: { interval: () => () => {} },
        });
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const writing = lock("force-test", () => gate);
        try {
            await controller.start();
            await controller.install();
            await controller.forceInstall();
            expect(mock.calls.install).toBe(0);
            expect(controller.getSnapshot().canForceInstall).toBe(false);
            release();
            await writing;
            await controller.install();
            await controller.forceInstall();
            expect(mock.calls.install).toBe(1);
        } finally { release(); await writing; controller.dispose(); }
    }
});

test("forced installation is offered only after a save failure and still rechecks active writes", async () => {
    const mock = mockBinding(state({status: "ready", latestVersion: "v1.5.2"}));
    let saving = false;
    let saveCalls = 0;
    const controller = createDesktopUpdateController({
        getBinding: () => mock.binding, isDesktopRuntime: () => true,
        persistWorkspace: async () => {saveCalls++; throw new Error("保存失败");},
        assertNoActiveSaves: async () => {if (saving) throw new DesktopUpdateSaveInProgressError();},
        scheduler: {interval: () => () => {}},
    });
    try {
        await controller.start();
        await controller.forceInstall();
        expect(mock.calls.install).toBe(0);
        await controller.install();
        expect(controller.getSnapshot().canForceInstall).toBe(true);
        expect(mock.calls.install).toBe(0);
        saving = true;
        await controller.forceInstall();
        expect(mock.calls.install).toBe(0);
        expect(controller.getSnapshot().canForceInstall).toBe(false);
        saving = false;
        await controller.install();
        await controller.forceInstall();
        expect(mock.calls.install).toBe(1);
        expect(saveCalls).toBe(2);
        expect(controller.getSnapshot().canForceInstall).toBe(false);
    } finally {controller.dispose();}
});

test("ongoing save and native install failures never offer forced installation", async () => {
    const mock = mockBinding(state({status: "ready", latestVersion: "v1.5.2"}));
    let saving = true;
    mock.binding.InstallUpdate = async () => {throw new Error("native failure");};
    const controller = createDesktopUpdateController({
        getBinding: () => mock.binding, isDesktopRuntime: () => true,
        persistWorkspace: async () => {if(saving) throw new DesktopUpdateSaveInProgressError();},
        scheduler: {interval: () => () => {}},
    });
    try {
        await controller.start();await controller.install();
        expect(controller.getSnapshot().canForceInstall).toBe(false);
        saving = false;await controller.retry();
        expect(controller.getSnapshot().state.error).toBe("native failure");
        expect(controller.getSnapshot().canForceInstall).toBe(false);
    } finally {controller.dispose();}
});

test("native preparation phases survive polling and expose file progress", () => {
    const parsed = parseDesktopUpdateState({ status: "installing", phase: "extracting", completedFiles: 128, totalFiles: 512 });
    expect(parsed.phase).toBe("extracting");
    expect(desktopUpdateDetailLabel(parsed)).toBe("128 / 512 个文件");
    expect(parseDesktopUpdateState({ status: "installing", phase: "untrusted" }).phase).toBeUndefined();
    expect(desktopUpdateDetailLabel({ ...parsed, phase: "restarting" })).toBe("完成后将自动打开新版本");
});

test("save timeout allows retry but late completion never installs", async () => {
    const save = deferred<void>();
    let stuck = true;
    const mock = mockBinding(state({ status: "ready", latestVersion: "v1.5.2" }));
    const controller = createDesktopUpdateController({
        getBinding: () => mock.binding,
        isDesktopRuntime: () => true,
        persistWorkspace: () => stuck ? save.promise : Promise.resolve(),
        persistTimeoutMs: 5,
        scheduler: { interval: () => () => {} },
    });
    await controller.start();
    await controller.install();
    expect(controller.getSnapshot().state.status).toBe("error");
    expect(controller.getSnapshot().persistBusy).toBe(false);
    expect(controller.getSnapshot().state.error).toContain("保存耗时较长");
    expect(mock.calls.install).toBe(0);
    save.resolve();
    await Promise.resolve();
    expect(mock.calls.install).toBe(0);
    stuck = false;
    await controller.retry();
    expect(mock.calls.install).toBe(1);
    controller.dispose();
});

test("disposing during save never starts native installation", async () => {
    const save = deferred<void>();
    const mock = mockBinding(state({ status: "ready", latestVersion: "v1.5.2" }));
    const controller = createDesktopUpdateController({ getBinding: () => mock.binding, isDesktopRuntime: () => true, persistWorkspace: () => save.promise, scheduler: { interval: () => () => {} } });
    await controller.start();
    const install = controller.install();
    controller.dispose();
    save.resolve();
    await install;
    expect(mock.calls.install).toBe(0);
});

test("retry cannot overlap a timed-out save; a late rejection is handled and a fresh save is required", async () => {
    const pending = deferred<void>();
    const mock = mockBinding(state({ status: "ready", latestVersion: "v1.5.2" }));
    let saves = 0;
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => { unhandled.push(error); };
    process.on("unhandledRejection", onUnhandled);
    const controller = createDesktopUpdateController({
        getBinding: () => mock.binding,
        isDesktopRuntime: () => true,
        persistWorkspace: () => ++saves === 1 ? pending.promise : Promise.resolve(),
        persistTimeoutMs: 5,
        scheduler: { interval: () => () => {} },
    });
    try {
        await controller.start();
        await controller.install();
        await controller.retry();
        expect(saves).toBe(1);
        expect(mock.calls.install).toBe(0);
        expect(controller.getSnapshot().state.error).toBe("上次保存仍未结束，请稍后重试。");
        pending.reject(new Error("late save failure"));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(unhandled).toEqual([]);
        expect(mock.calls.install).toBe(0);
        await controller.retry();
        expect(saves).toBe(2);
        expect(mock.calls.install).toBe(1);
    } finally {
        process.off("unhandledRejection", onUnhandled);
        controller.dispose();
    }
});

test("an editor save refusal prevents native installation and retries after saving", async () => {
    let unsaved = true;
    const unregister = registerDesktopUpdatePreparation(() => {
        if (unsaved) throw new Error("剪辑内容尚未保存完成。");
    });
    const mock = mockBinding(state({ status: "ready", latestVersion: "v1.5.2" }));
    const controller = createDesktopUpdateController({
        getBinding: () => mock.binding,
        isDesktopRuntime: () => true,
        persistWorkspace: prepareDesktopEditorsForUpdate,
        scheduler: { interval: () => () => {} },
    });
    try {
        await controller.start();
        await controller.install();
        expect(mock.calls.install).toBe(0);
        expect(controller.getSnapshot().state.error).toBe("剪辑内容尚未保存完成。");
        unsaved = false;
        await controller.retry();
        expect(mock.calls.install).toBe(1);
    } finally {
        unregister();
        controller.dispose();
    }
});

test("late progress polling cannot overwrite a completed download", async () => {
    const mock = mockBinding(state({ status: "available", latestVersion: "v1.5.2" }));
    mock.holdDownload();
    let tick: (() => void) | undefined;
    const controller = createDesktopUpdateController({
        getBinding: () => mock.binding,
        isDesktopRuntime: () => true,
        persistWorkspace: async () => {},
        scheduler: {
            interval: (callback) => {
                tick = callback;
                return () => {};
            },
        },
    });
    const unsubscribe = controller.subscribe(() => {});
    try {
        await controller.start();
        const download = controller.download();
        const oldPoll = deferred<DesktopUpdateState>();
        mock.binding.UpdateStatus = () => oldPoll.promise;
        tick!();
        mock.finishDownload(state({ status: "ready", latestVersion: "v1.5.2" }));
        await download;
        oldPoll.resolve(state({ status: "downloading", latestVersion: "v1.5.2" }));
        await Promise.resolve();
        await Promise.resolve();
        expect(controller.getSnapshot().state.status).toBe("ready");
    } finally {
        unsubscribe();
        controller.dispose();
    }
});

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function state(partial: Partial<DesktopUpdateState> & Pick<DesktopUpdateState, "status">): DesktopUpdateState {
    return {
        currentVersion: "v1.5.1",
        latestVersion: "",
        releaseNotes: "",
        downloadedBytes: 0,
        totalBytes: 0,
        bytesPerSecond: 0,
        reconnecting: false,
        error: "",
        ...partial,
    };
}

function mockBinding(initial: DesktopUpdateState) {
    let current = initial;
    const calls = { status: 0, check: 0, download: 0, install: 0 };
    const downloadGate = deferred<DesktopUpdateState>();
    let useDownloadGate = false;
    const installGate = deferred<void>();
    let useInstallGate = false;
    const binding: DesktopRuntimeBinding = {
        RuntimeConfig: async () => ({ baseURL: "http://127.0.0.1:43123/api", launchToken: "token" }),
        UpdateStatus: async () => {
            calls.status += 1;
            return current;
        },
        CheckForUpdate: async () => {
            calls.check += 1;
            return current;
        },
        DownloadUpdate: async () => {
            calls.download += 1;
            if (useDownloadGate) return downloadGate.promise;
            return current;
        },
        InstallUpdate: async () => {
            calls.install += 1;
            if (useInstallGate) return installGate.promise;
        },
    };
    return {
        binding,
        calls,
        setState: (next: DesktopUpdateState) => {
            current = next;
        },
        holdDownload: () => {
            useDownloadGate = true;
        },
        finishDownload: (next: DesktopUpdateState) => {
            current = next;
            useDownloadGate = false;
            downloadGate.resolve(next);
        },
        failDownload: (error: unknown) => {
            useDownloadGate = false;
            downloadGate.reject(error);
        },
        holdInstall: () => {
            useInstallGate = true;
        },
        finishInstall: () => {
            installGate.resolve();
        },
        failInstall: (error: unknown) => {
            installGate.reject(error);
        },
    };
}

function collect(controller: ReturnType<typeof createDesktopUpdateController>) {
    const snapshots: DesktopUpdateSnapshot[] = [];
    const stop = controller.subscribe((snapshot) => {
        snapshots.push(snapshot);
    });
    return {
        snapshots,
        latest: () => snapshots[snapshots.length - 1],
        stop,
    };
}

describe("desktop update progress", () => {
    test("reads speed and reconnect state from the native contract", () => {
        const parsed = parseDesktopUpdateState({ status: "downloading", downloadedBytes: 10, totalBytes: 20, bytesPerSecond: "2048", reconnecting: true });
        expect(parsed.bytesPerSecond).toBe(2048);
        expect(parsed.reconnecting).toBe(true);
        expect(parseDesktopUpdateState({ status: "downloading", reconnecting: "yes" }).reconnecting).toBe(false);
    });

    test("shows speed with time left, then falls back to amounts or connecting", () => {
        const mb = 1024 * 1024;
        expect(desktopUpdateDetailLabel(state({ status: "downloading", downloadedBytes: 30 * mb, totalBytes: 150 * mb, bytesPerSecond: 2 * mb }))).toBe("2.0 MB/s · 剩余约 1 分钟");
        expect(desktopUpdateDetailLabel(state({ status: "downloading", downloadedBytes: 30 * mb, totalBytes: 150 * mb, bytesPerSecond: 512 * 1024 }))).toBe("512 KB/s · 剩余约 4 分钟");
        expect(desktopUpdateDetailLabel(state({ status: "downloading", downloadedBytes: 30 * mb, totalBytes: 150 * mb }))).toBe("30 MB / 150 MB");
        expect(desktopUpdateDetailLabel(state({ status: "downloading", totalBytes: 150 * mb }))).toBe("正在连接");
        const downloaded = state({ status: "downloading", downloadedBytes: 150 * mb, totalBytes: 150 * mb, bytesPerSecond: mb });
        expect(desktopUpdateDetailLabel(downloaded)).toBe("下载完成，正在校验更新包");
        expect(desktopUpdateProgressPercent(downloaded)).toBeLessThan(100);
        expect(desktopUpdateDetailLabel(state({ status: "downloading", downloadedBytes: 30 * mb, totalBytes: 150 * mb, bytesPerSecond: mb, reconnecting: true }))).toBe("网络中断，正在重新连接");
        expect(desktopUpdateDetailLabel(state({ status: "error", error: "网络不稳定，已保留下载进度" }))).toBe("网络不稳定，已保留下载进度");
    });

    test("formats remaining time without false precision", () => {
        expect(formatDesktopUpdateRemaining(null)).toBe("");
        expect(formatDesktopUpdateRemaining(20)).toBe("剩余不到 1 分钟");
        expect(formatDesktopUpdateRemaining(61)).toBe("剩余约 2 分钟");
        expect(formatDesktopUpdateRemaining(3600)).toBe("剩余约 1 小时");
        expect(formatDesktopUpdateRemaining(5400)).toBe("剩余约 1 小时 30 分钟");
    });

    test("only a failed partial download is resumable", () => {
        expect(hasResumableDesktopUpdate(state({ status: "error", downloadedBytes: 5, totalBytes: 10 }))).toBe(true);
        expect(hasResumableDesktopUpdate(state({ status: "error", downloadedBytes: 0, totalBytes: 10 }))).toBe(false);
        expect(hasResumableDesktopUpdate(state({ status: "downloading", downloadedBytes: 5, totalBytes: 10 }))).toBe(false);
    });
});

describe("desktop update parsing", () => {
    test("reads the frozen JSON contract fields and ignores unknown status", () => {
        expect(
            parseDesktopUpdateState({
                status: "available",
                currentVersion: "v1.5.1",
                latestVersion: "v1.5.2",
                releaseNotes: "修复保存",
                downloadedBytes: "12",
                totalBytes: 40,
                error: "",
            }),
        ).toEqual({
            status: "available",
            currentVersion: "v1.5.1",
            latestVersion: "v1.5.2",
            releaseNotes: "修复保存",
            downloadedBytes: 12,
            totalBytes: 40,
            bytesPerSecond: 0,
            reconnecting: false,
            error: "",
        });
        expect(parseDesktopUpdateState({ status: "nope", error: "boom" }).status).toBe("error");
        expect(formatDesktopVersionLabel("1.5.1")).toBe("v1.5.1");
        expect(desktopUpdateActionLabel("available")).toBe("下载更新");
        expect(desktopUpdateActionLabel("ready")).toBe("安装更新");
        expect(desktopUpdateProgressLabel(state({ status: "downloading", downloadedBytes: 12 * 1024 * 1024, totalBytes: 40 * 1024 * 1024 }))).toBe("12 MB / 40 MB");
        expect(userFacingDesktopUpdateError("Get https://github.com/glanderness/BeefTV/releases/latest/download/desktop-update.json")).toBe("更新没有完成，请再试一次。");
        expect(userFacingDesktopUpdateError("画布没有保存完成，更新没有开始。请稍后再试。")).toBe("画布没有保存完成，更新没有开始。请稍后再试。");
    });

    test("requires the four Wails update methods before treating the binding as live", () => {
        expect(hasDesktopUpdateBinding({ RuntimeConfig: async () => ({ baseURL: "http://127.0.0.1:1/api", launchToken: "x" }) })).toBe(false);
        expect(
            hasDesktopUpdateBinding({
                RuntimeConfig: async () => ({ baseURL: "http://127.0.0.1:1/api", launchToken: "x" }),
                UpdateStatus: async () => state({ status: "idle" }),
                CheckForUpdate: async () => state({ status: "idle" }),
                DownloadUpdate: async () => state({ status: "idle" }),
                InstallUpdate: async () => undefined,
            }),
        ).toBe(true);
    });
});

describe("desktop update controller", () => {
    test("available download ready restart waits for workspace persist", async () => {
        const available = state({
            status: "available",
            latestVersion: "v1.5.2",
            releaseNotes: "画布保存更稳",
        });
        const mock = mockBinding(available);
        const persist = deferred<void>();
        let persistCalls = 0;
        let ticks: Array<() => void> = [];
        const controller = createDesktopUpdateController({
            getBinding: () => mock.binding,
            isDesktopRuntime: () => true,
            persistWorkspace: async () => {
                persistCalls += 1;
                return persist.promise;
            },
            fallbackVersion: "v1.5.1",
            scheduler: {
                interval: (tick) => {
                    ticks.push(tick);
                    return () => {
                        ticks = ticks.filter((item) => item !== tick);
                    };
                },
            },
        });
        const view = collect(controller);

        await controller.start();
        expect(mock.calls.check).toBe(1);
        expect(view.latest().state.status).toBe("available");
        expect(shouldShowDesktopUpdaterControls(view.latest()!)).toBe(true);

        mock.holdDownload();
        const downloading = state({
            status: "downloading",
            latestVersion: "v1.5.2",
            downloadedBytes: 8 * 1024 * 1024,
            totalBytes: 40 * 1024 * 1024,
        });
        mock.setState(downloading);
        const downloadPromise = controller.download();
        expect(view.latest().state.status).toBe("downloading");
        mock.setState({ ...downloading, downloadedBytes: 24 * 1024 * 1024 });
        ticks[0]!();
        await Promise.resolve();
        await Promise.resolve();
        expect(view.latest().state.downloadedBytes).toBe(24 * 1024 * 1024);

        const ready = state({ status: "ready", latestVersion: "v1.5.2", releaseNotes: "画布保存更稳" });
        mock.finishDownload(ready);
        await downloadPromise;
        expect(view.latest().state.status).toBe("ready");
        expect(mock.calls.download).toBe(1);

        mock.holdInstall();
        const installationStarted = deferred<void>();
        const originalInstall = mock.binding.InstallUpdate!;
        mock.binding.InstallUpdate = () => { installationStarted.resolve(); return originalInstall(); };
        const installPromise = controller.install();
        await Promise.resolve();
        expect(persistCalls).toBe(1);
        expect(mock.calls.install).toBe(0);
        expect(view.latest().persistBusy).toBe(true);

        persist.resolve();
        await installationStarted.promise;
        expect(mock.calls.install).toBe(1);
        expect(view.latest().state.status).toBe("installing");
        mock.finishInstall();
        await installPromise;
        expect(view.latest().state.status).toBe("installing");
        view.stop();
    });

    test("download failure can retry without a second startup check", async () => {
        const available = state({ status: "available", latestVersion: "v1.5.2" });
        const mock = mockBinding(available);
        const controller = createDesktopUpdateController({
            getBinding: () => mock.binding,
            isDesktopRuntime: () => true,
            persistWorkspace: async () => undefined,
            fallbackVersion: "v1.5.1",
            scheduler: { interval: () => () => {} },
        });
        const view = collect(controller);
        await controller.start();

        mock.holdDownload();
        const first = controller.download();
        await Promise.resolve();
        mock.failDownload(new Error("disk full"));
        await first;
        expect(view.latest().state.status).toBe("error");
        expect(userFacingDesktopUpdateError(view.latest().state.error)).toBe("更新没有完成，请再试一次。");

        mock.setState(state({ status: "ready", latestVersion: "v1.5.2" }));
        await controller.retry();
        expect(mock.calls.check).toBe(1);
        expect(mock.calls.download).toBe(2);
        expect(view.latest().state.status).toBe("ready");
        view.stop();
    });

    test("install is not called when canvas persist fails", async () => {
        const mock = mockBinding(state({ status: "ready", latestVersion: "v1.5.2" }));
        const controller = createDesktopUpdateController({
            getBinding: () => mock.binding,
            isDesktopRuntime: () => true,
            persistWorkspace: async () => {
                throw new Error("indexeddb locked");
            },
            fallbackVersion: "v1.5.1",
            scheduler: { interval: () => () => {} },
        });
        const view = collect(controller);
        await controller.start();
        await controller.install();
        expect(mock.calls.install).toBe(0);
        expect(view.latest().state.status).toBe("error");
        expect(view.latest().state.error).toBe("内容没有保存完成，更新没有开始。请稍后再试。");
        view.stop();
    });

    test("browser and disabled runtimes never call CheckForUpdate", async () => {
        const mock = mockBinding(state({ status: "idle" }));
        const browser = createDesktopUpdateController({
            getBinding: () => mock.binding,
            isDesktopRuntime: () => false,
            persistWorkspace: async () => undefined,
            fallbackVersion: "v1.5.1",
            scheduler: { interval: () => () => {} },
        });
        const browserView = collect(browser);
        await browser.start();
        await browser.download();
        await browser.install();
        expect(mock.calls.check).toBe(0);
        expect(mock.calls.download).toBe(0);
        expect(mock.calls.install).toBe(0);
        expect(browserView.latest().runtime).toBe("browser");
        expect(shouldShowDesktopUpdaterControls(browserView.latest()!)).toBe(false);
        expect(browserView.latest().state.currentVersion).toBe("v1.5.1");
        browserView.stop();

        const disabled = mockBinding(state({ status: "disabled", currentVersion: "v1.5.1" }));
        const desktopDisabled = createDesktopUpdateController({
            getBinding: () => disabled.binding,
            isDesktopRuntime: () => true,
            persistWorkspace: async () => undefined,
            fallbackVersion: "v1.5.1",
            scheduler: { interval: () => () => {} },
        });
        const disabledView = collect(desktopDisabled);
        await desktopDisabled.start();
        expect(disabled.calls.check).toBe(0);
        expect(disabledView.latest().state.status).toBe("disabled");
        expect(shouldShowDesktopUpdaterControls(disabledView.latest()!)).toBe(false);
        disabledView.stop();
    });

    test("startup CheckForUpdate runs once across remounts and unmount cancels polling", async () => {
        const idle = state({ status: "idle" });
        const mock = mockBinding(idle);
        const checkGate = deferred<DesktopUpdateState>();
        mock.binding.CheckForUpdate = async () => {
            mock.calls.check += 1;
            return checkGate.promise;
        };
        let ticks: Array<() => void> = [];
        const controller = createDesktopUpdateController({
            getBinding: () => mock.binding,
            isDesktopRuntime: () => true,
            persistWorkspace: async () => undefined,
            fallbackVersion: "v1.5.1",
            scheduler: {
                interval: (tick) => {
                    ticks.push(tick);
                    return () => {
                        ticks = ticks.filter((item) => item !== tick);
                    };
                },
            },
        });

        const first = collect(controller);
        const startFirst = controller.start();
        const second = collect(controller);
        void controller.start();
        await Promise.resolve();
        await Promise.resolve();
        expect(mock.calls.check).toBe(1);

        first.stop();
        checkGate.resolve(state({ status: "available", latestVersion: "v1.5.2" }));
        await startFirst;
        expect(second.latest().state.status).toBe("available");
        expect(mock.calls.check).toBe(1);

        mock.holdDownload();
        mock.setState(state({ status: "downloading", latestVersion: "v1.5.2", downloadedBytes: 1, totalBytes: 10 }));
        void controller.download();
        expect(ticks.length).toBe(1);
        const statusBeforeUnmount = mock.calls.status;
        second.stop();
        expect(ticks.length).toBe(0);
        expect(mock.calls.status).toBe(statusBeforeUnmount);

        const third = collect(controller);
        expect(mock.calls.check).toBe(1);
        expect(third.latest().state.status).toBe("downloading");
        expect(ticks.length).toBe(1);
        third.stop();
    });

    test("startup check failures keep the installed version and retry in the background", async () => {
        const mock = mockBinding(state({ status: "idle", currentVersion: "v1.5.1" }));
        mock.binding.CheckForUpdate = async () => {
            mock.calls.check += 1;
            throw new Error("https://github.com/glanderness/BeefTV/releases/latest/download/desktop-update.json");
        };
        const controller = createDesktopUpdateController({
            getBinding: () => mock.binding,
            isDesktopRuntime: () => true,
            persistWorkspace: async () => undefined,
            fallbackVersion: "v1.5.1",
            scheduler: { interval: () => () => {} },
        });
        const view = collect(controller);
        await controller.start();
        expect(view.latest().state.status).toBe("error");
        expect(userFacingDesktopUpdateError(view.latest().state.error)).toBe("更新没有完成，请再试一次。");
        expect(view.latest().state.currentVersion).toBe("v1.5.1");
        expect(shouldShowDesktopUpdaterControls(view.latest()!)).toBe(false);
        mock.binding.CheckForUpdate = async () => {
            mock.calls.check += 1;
            return state({ status: "available", latestVersion: "v1.5.5" });
        };
        await controller.check();
        expect(mock.calls.check).toBe(2);
        expect(view.latest().state.status).toBe("available");
        view.stop();
    });

    test("an up-to-date desktop checks again in the background after a new release", async () => {
        const mock = mockBinding(state({ status: "idle", currentVersion: "v1.5.4", latestVersion: "v1.5.4" }));
        const controller = createDesktopUpdateController({ getBinding: () => mock.binding, isDesktopRuntime: () => true, scheduler: { interval: () => () => {} } });
        await controller.start();
        expect(shouldShowDesktopUpdaterControls(controller.getSnapshot())).toBe(false);
        const successfulCheck = mock.binding.CheckForUpdate!;
        mock.binding.CheckForUpdate = async () => {
            mock.calls.check += 1;
            throw new Error("无法检查更新");
        };
        await controller.check();
        expect(controller.getSnapshot().state.status).toBe("error");
        expect(controller.getSnapshot().state.latestVersion).toBe("v1.5.4");
        mock.binding.CheckForUpdate = successfulCheck;
        mock.setState(state({ status: "available", latestVersion: "v1.5.5" }));
        await controller.check();
        expect(mock.calls.check).toBe(3);
        expect(mock.calls.download).toBe(0);
        expect(controller.getSnapshot().state.status).toBe("available");
        expect(shouldShowDesktopUpdaterControls(controller.getSnapshot())).toBe(true);
        controller.dispose();
    });

    test("background check refreshes an available release before download", async () => {
        const mock = mockBinding(state({ status: "available", latestVersion: "v1.5.2" }));
        const controller = createDesktopUpdateController({ getBinding: () => mock.binding, isDesktopRuntime: () => true, scheduler: { interval: () => () => {} } });
        await controller.start();
        mock.setState(state({ status: "available", latestVersion: "v1.5.3" }));
        await controller.check();
        expect(mock.calls.check).toBe(2);
        expect(controller.getSnapshot().state.latestVersion).toBe("v1.5.3");
        controller.dispose();
    });

    test("one click downloads a verified update then installs only after saving", async () => {
        const mock = mockBinding(state({ status: "available", latestVersion: "v1.5.2" }));
        mock.holdDownload();
        let persistCalls = 0;
        const controller = createDesktopUpdateController({
            getBinding: () => mock.binding,
            isDesktopRuntime: () => true,
            persistWorkspace: async () => { persistCalls += 1; },
            scheduler: { interval: () => () => {} },
        });
        await controller.start();
        const update = controller.downloadAndInstall();
        expect(mock.calls.download).toBe(1);
        expect(mock.calls.install).toBe(0);
        mock.finishDownload(state({ status: "ready", latestVersion: "v1.5.2" }));
        await update;
        expect(persistCalls).toBe(1);
        expect(mock.calls.install).toBe(1);
        controller.dispose();
    });

    test("one click does not install if download fails and can retry", async () => {
        const mock = mockBinding(state({ status: "available", latestVersion: "v1.5.2" }));
        mock.holdDownload();
        const controller = createDesktopUpdateController({
            getBinding: () => mock.binding,
            isDesktopRuntime: () => true,
            persistWorkspace: async () => undefined,
            scheduler: { interval: () => () => {} },
        });
        await controller.start();
        const first = controller.downloadAndInstall();
        mock.failDownload(new Error("network failed"));
        await first;
        expect(controller.getSnapshot().state.status).toBe("error");
        expect(mock.calls.install).toBe(0);
        mock.setState(state({ status: "ready", latestVersion: "v1.5.2" }));
        await controller.downloadAndInstall();
        expect(mock.calls.download).toBe(2);
        expect(mock.calls.install).toBe(1);
        controller.dispose();
    });
});

 test("100 percent requires helper readiness, never just complete bytes", () => {
    const base = { status: "downloading", currentVersion: "v1.7.16", latestVersion: "v1.7.17", releaseNotes: "", downloadedBytes: 100, totalBytes: 100, bytesPerSecond: 0, reconnecting: false, error: "" } as DesktopUpdateState;
    expect(desktopUpdateProgressPercent(base)).toBe(95);
    expect(desktopUpdateProgressPercent({ ...base, status: "ready" })).toBe(96);
    expect(desktopUpdateProgressPercent({ ...base, status: "installing" })).toBe(98);
    expect(desktopUpdateProgressPercent({ ...base, status: "installing", installPrepared: true })).toBe(100);
    expect(desktopUpdateProgressPercent({ ...base, status: "error", installPrepared: true })).toBeLessThan(100);
 });
