import { DESKTOP_UPDATE_STATUSES, getDesktopUpdateBinding, type DesktopUpdateBinding, type DesktopUpdateState, type DesktopUpdateStatus } from "@/services/desktop-runtime";
import { assertDesktopUpdateProgressSettled, DesktopUpdateSaveInProgressError, hasActiveDesktopEditorSaves, prepareDesktopEditorsForUpdate } from "@/services/desktop-update-preparation";

export type { DesktopUpdateState, DesktopUpdateStatus };

export const DESKTOP_UPDATE_POLL_INTERVAL_MS = 400;
export const DESKTOP_UPDATE_CHECK_INTERVAL_MS = 15 * 60 * 1000;

const POLLED_STATUSES = new Set<DesktopUpdateStatus>(["checking", "downloading", "installing"]);

export type DesktopUpdateRuntimeKind = "desktop" | "browser";

export type DesktopUpdateSnapshot = {
    state: DesktopUpdateState;
    persistBusy: boolean;
    actionBusy: boolean;
    runtime: DesktopUpdateRuntimeKind;
    canForceInstall: boolean;
};

export type DesktopUpdateScheduler = {
    interval: (tick: () => void, ms: number) => () => void;
};

export type DesktopUpdateControllerOptions = {
	/** Save deadline; expiration must never continue into native installation. */
	persistTimeoutMs?: number;
    getBinding?: () => DesktopUpdateBinding | undefined;
    isDesktopRuntime?: () => boolean;
    persistWorkspace?: () => Promise<void>;
    assertNoActiveSaves?: () => Promise<void>;
    fallbackVersion?: string;
    pollIntervalMs?: number;
    scheduler?: DesktopUpdateScheduler;
};

export type DesktopUpdateController = {
    getSnapshot: () => DesktopUpdateSnapshot;
    subscribe: (listener: (snapshot: DesktopUpdateSnapshot) => void) => () => void;
    start: () => Promise<void>;
    check: () => Promise<void>;
    download: () => Promise<void>;
    install: () => Promise<void>;
    forceInstall: () => Promise<void>;
    downloadAndInstall: () => Promise<void>;
    retry: () => Promise<void>;
    dispose: () => void;
};

type InternalPhase = "none" | "check" | "download" | "install";

function isDesktopUpdateStatus(value: unknown): value is DesktopUpdateStatus {
    return typeof value === "string" && (DESKTOP_UPDATE_STATUSES as readonly string[]).includes(value);
}

function readText(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function readBytes(value: unknown): number {
    if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.floor(value));
    if (typeof value === "string" && value.trim()) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return Math.max(0, Math.floor(parsed));
    }
    return 0;
}

export function emptyDesktopUpdateState(currentVersion = ""): DesktopUpdateState {
    return {
        status: "disabled",
        currentVersion,
        latestVersion: "",
        releaseNotes: "",
        downloadedBytes: 0,
        totalBytes: 0,
        bytesPerSecond: 0,
        reconnecting: false,
        error: "",
    };
}

export function parseDesktopUpdateState(value: unknown, fallbackCurrentVersion = ""): DesktopUpdateState {
    const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    const currentVersion = readText(source.currentVersion) || fallbackCurrentVersion;
    const error = readText(source.error);
    const status = isDesktopUpdateStatus(source.status) ? source.status : error ? "error" : "idle";
    return {
        status,
        ...(["downloading", "verifying", "extracting", "preparing", "restarting"].includes(readText(source.phase)) ? {
            phase: readText(source.phase) as DesktopUpdateState["phase"],
            completedFiles: readBytes(source.completedFiles),
            totalFiles: readBytes(source.totalFiles),
        } : {}),
        ...(source.installPrepared === true ? { installPrepared: true } : {}),
        currentVersion,
        latestVersion: readText(source.latestVersion),
        releaseNotes: readText(source.releaseNotes),
        downloadedBytes: readBytes(source.downloadedBytes),
        totalBytes: readBytes(source.totalBytes),
        bytesPerSecond: readBytes(source.bytesPerSecond),
        reconnecting: source.reconnecting === true,
        error,
    };
}

export function formatDesktopVersionLabel(version: string): string {
    const raw = version.trim();
    if (!raw) return "";
    return raw.startsWith("v") ? raw : `v${raw.replace(/^v/, "")}`;
}

export function hasDesktopUpdateBinding(binding: DesktopUpdateBinding | undefined): binding is Required<DesktopUpdateBinding> {
    return typeof binding?.UpdateStatus === "function" && typeof binding?.CheckForUpdate === "function" && typeof binding?.DownloadUpdate === "function" && typeof binding?.InstallUpdate === "function";
}

export function isDesktopUpdateRuntime(binding = getDesktopUpdateBinding()): boolean {
    if (typeof window === "undefined") return false;
    return window.location?.protocol === "wails:" || hasDesktopUpdateBinding(binding);
}

export function shouldPollDesktopUpdate(status: DesktopUpdateStatus): boolean {
    return POLLED_STATUSES.has(status);
}

export function desktopUpdateProgressPercent(state: DesktopUpdateState): number | null {
    if (state.totalBytes <= 0) return null;
    if (state.status === "installing" && state.installPrepared) return 100;
    if (state.status === "installing") return 98;
    if (state.status === "ready") return 96;
    return Math.min(95, Math.floor((state.downloadedBytes / state.totalBytes) * 95));
}

export function formatDesktopUpdateBytes(bytes: number): string {
    if (bytes < 1024) return `${Math.max(0, Math.floor(bytes))} B`;
    if (bytes < 1024 * 1024) {
        const kilo = bytes / 1024;
        return `${kilo < 10 ? kilo.toFixed(1) : Math.round(kilo)} KB`;
    }
    const mega = bytes / (1024 * 1024);
    return `${mega < 10 ? mega.toFixed(1) : Math.round(mega)} MB`;
}

export function desktopUpdateProgressLabel(state: DesktopUpdateState): string {
    const percent = desktopUpdateProgressPercent(state);
    if (state.totalBytes > 0) {
        return `${formatDesktopUpdateBytes(state.downloadedBytes)} / ${formatDesktopUpdateBytes(state.totalBytes)}`;
    }
    if (percent !== null) return `${percent}%`;
    return "正在下载";
}

export function formatDesktopUpdateSpeed(bytesPerSecond: number): string {
    return bytesPerSecond > 0 ? `${formatDesktopUpdateBytes(bytesPerSecond)}/s` : "";
}

export function desktopUpdateRemainingSeconds(state: DesktopUpdateState): number | null {
    if (state.bytesPerSecond <= 0 || state.totalBytes <= 0 || state.downloadedBytes >= state.totalBytes) return null;
    return (state.totalBytes - state.downloadedBytes) / state.bytesPerSecond;
}

export function formatDesktopUpdateRemaining(seconds: number | null): string {
    if (seconds === null || !Number.isFinite(seconds)) return "";
    if (seconds < 60) return "剩余不到 1 分钟";
    if (seconds < 3600) return `剩余约 ${Math.ceil(seconds / 60)} 分钟`;
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.round((seconds % 3600) / 60);
    return minutes ? `剩余约 ${hours} 小时 ${minutes} 分钟` : `剩余约 ${hours} 小时`;
}

/** Secondary line under the download status: speed and time left, or why it paused. */
export function desktopUpdateDetailLabel(state: DesktopUpdateState): string {
    if (state.status === "installing") {
        if (state.phase === "extracting" && state.totalFiles) return `${state.completedFiles ?? 0} / ${state.totalFiles} 个文件`;
        if (state.phase === "restarting" || state.installPrepared) return "完成后将自动打开新版本";
        return "请保持应用开启";
    }
    if (state.status === "downloading") {
        if (state.reconnecting) return "网络中断，正在重新连接";
        if (state.totalBytes > 0 && state.downloadedBytes >= state.totalBytes) return "下载完成，正在校验更新包";
        const speed = formatDesktopUpdateSpeed(state.bytesPerSecond);
        if (speed) return [speed, formatDesktopUpdateRemaining(desktopUpdateRemainingSeconds(state))].filter(Boolean).join(" · ");
        return state.downloadedBytes > 0 && state.totalBytes > 0 ? desktopUpdateProgressLabel(state) : "正在连接";
    }
    if (state.status === "error") return userFacingDesktopUpdateError(state.error);
    return "";
}

/** True when a failed download left bytes that the next attempt continues from. */
export function hasResumableDesktopUpdate(state: DesktopUpdateState): boolean {
    return state.status === "error" && state.downloadedBytes > 0 && state.totalBytes > 0 && state.downloadedBytes < state.totalBytes;
}

export function desktopUpdateActionLabel(status: DesktopUpdateStatus): string {
    switch (status) {
        case "available":
            return "下载更新";
        case "downloading":
            return "正在下载";
        case "ready":
            return "安装更新";
        case "installing":
            return "正在安装";
        case "error":
            return "再试一次";
        case "checking":
            return "正在检查";
        case "idle":
            return "检查更新";
        default:
            return "";
    }
}

export function userFacingDesktopUpdateError(error: string): string {
    const trimmed = error.trim();
    if (!trimmed || trimmed.length > 80 || /https?:\/\//i.test(trimmed) || /github/i.test(trimmed) || !/[\u4e00-\u9fff]/u.test(trimmed)) {
        return "更新没有完成，请再试一次。";
    }
    return trimmed;
}

export function shouldShowDesktopUpdaterControls(snapshot: DesktopUpdateSnapshot): boolean {
    if (snapshot.runtime !== "desktop") return false;
    if (["available", "downloading", "ready", "installing"].includes(snapshot.state.status)) return true;
    return snapshot.state.status === "error" && Boolean(snapshot.state.latestVersion) && formatDesktopVersionLabel(snapshot.state.latestVersion) !== formatDesktopVersionLabel(snapshot.state.currentVersion);
}

function bindingErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message.trim()) return error.message.trim();
    if (typeof error === "string" && error.trim()) return error.trim();
    return "";
}

function readBuildVersion(): string {
    return typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "";
}

export async function persistWorkspaceBeforeDesktopInstall() {
    await prepareDesktopEditorsForUpdate();
    const [{ flushCanvasStorePersistence }, { flushAssetStorePersistence }, { flushModelConfig, getModelConfigPersistenceState }] = await Promise.all([import("@/stores/canvas/use-canvas-store"), import("@/stores/use-asset-store"), import("@/services/model-config-repository")]);
    // A failed store must not offer restart while another store is still writing.
    const results = await Promise.allSettled([flushCanvasStorePersistence(), flushAssetStorePersistence(), flushModelConfig()]);
    const failed = results.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    const modelConfig = getModelConfigPersistenceState();
    if (modelConfig.status === "saving") throw new DesktopUpdateSaveInProgressError();
    if (modelConfig.dirty || modelConfig.status === "error") throw new Error("模型配置尚未保存完成，请重试保存，或选择仍然更新。");
    await assertDesktopSaveProgress();
    await assertNoActiveDesktopSaves();
}

export async function assertNoActiveDesktopSaves() {
    const [canvas, assets, generation, modelConfig, progress] = await Promise.all([
        import("@/stores/canvas/use-canvas-store"), import("@/stores/use-asset-store"),
        import("@/services/generation-asset-repository"), import("@/services/model-config-repository"),
        import("@/stores/use-sync-progress-store"),
    ]);
    if (hasActiveDesktopEditorSaves() || canvas.hasActiveCanvasStorePersistence() || assets.hasActiveAssetStorePersistence()
        || generation.hasActiveGenerationAssetWrites() || modelConfig.getModelConfigPersistenceState().status === "saving") {
        throw new DesktopUpdateSaveInProgressError();
    }
    assertDesktopUpdateProgressSettled(progress.useSyncProgressStore.getState().syncingProjects,
        new Set(canvas.useCanvasStore.getState().projects.map(project => project.id)), undefined, true);
}

async function assertDesktopSaveProgress(allowFailed = false) {
    const { useSyncProgressStore } = await import("@/stores/use-sync-progress-store");
    const { useCanvasStore } = await import("@/stores/canvas/use-canvas-store");
    assertDesktopUpdateProgressSettled(useSyncProgressStore.getState().syncingProjects, new Set(useCanvasStore.getState().projects.map(project => project.id)), undefined, allowFailed);
}

const defaultScheduler: DesktopUpdateScheduler = {
    interval: (tick, ms) => {
        const id = window.setInterval(tick, ms);
        return () => window.clearInterval(id);
    },
};

export function createDesktopUpdateController(options: DesktopUpdateControllerOptions = {}): DesktopUpdateController {
    const getBinding = options.getBinding ?? getDesktopUpdateBinding;
    const isDesktopRuntime = options.isDesktopRuntime ?? (() => isDesktopUpdateRuntime(getBinding()));
    const persistWorkspace = options.persistWorkspace ?? persistWorkspaceBeforeDesktopInstall;
    const assertNoActiveSaves = options.assertNoActiveSaves ?? assertNoActiveDesktopSaves;
    const fallbackVersion = options.fallbackVersion ?? readBuildVersion();
    const pollIntervalMs = options.pollIntervalMs ?? DESKTOP_UPDATE_POLL_INTERVAL_MS;
    const scheduler = options.scheduler ?? defaultScheduler;

    let state = emptyDesktopUpdateState(fallbackVersion);
    let persistBusy = false;
    let canForceInstall = false;
    let actionBusy = false;
    let lastAction: InternalPhase = "none";
    let stagedReady = false;
    let pendingPersistence: Promise<void> | null = null;
    let startPromise: Promise<void> | null = null;
    let stopPoll: (() => void) | null = null;
    let pollGeneration = 0;
    let stateRevision = 0;
    let disposed = false;
    const listeners = new Set<(snapshot: DesktopUpdateSnapshot) => void>();

    const runtimeKind = (): DesktopUpdateRuntimeKind => (isDesktopRuntime() && hasDesktopUpdateBinding(getBinding()) ? "desktop" : "browser");

    const getSnapshot = (): DesktopUpdateSnapshot => ({
        state: { ...state },
        persistBusy,
        actionBusy,
        runtime: runtimeKind(),
        canForceInstall,
    });

    const emit = () => {
        if (disposed) return;
        const snapshot = getSnapshot();
        listeners.forEach((listener) => listener(snapshot));
    };

    const apply = (next: DesktopUpdateState, extras?: { persistBusy?: boolean; actionBusy?: boolean }) => {
        stateRevision += 1;
        state = {
            ...next,
            currentVersion: next.currentVersion || fallbackVersion,
        };
        if (state.status === "ready") stagedReady = true;
        else if (state.status === "available" || state.status === "disabled" || state.status === "idle" || state.status === "checking") stagedReady = false;
        if (extras?.persistBusy !== undefined) persistBusy = extras.persistBusy;
        if (extras?.actionBusy !== undefined) actionBusy = extras.actionBusy;
        emit();
        syncPoll();
    };

    const syncPoll = () => {
        const shouldPoll = !disposed && listeners.size > 0 && shouldPollDesktopUpdate(state.status) && runtimeKind() === "desktop";
        if (!shouldPoll) {
            stopPoll?.();
            stopPoll = null;
            return;
        }
        if (stopPoll) return;
        const generation = ++pollGeneration;
        stopPoll = scheduler.interval(() => {
            if (generation !== pollGeneration) return;
            void refreshStatus();
        }, pollIntervalMs);
    };

    const refreshStatus = async () => {
        const binding = getBinding();
        if (!hasDesktopUpdateBinding(binding)) return;
        const revision = stateRevision;
        try {
            const next = parseDesktopUpdateState(await binding.UpdateStatus(), state.currentVersion || fallbackVersion);
            if (disposed || revision !== stateRevision) return;
            apply(next);
        } catch {
            // Polling is best-effort; keep the last known snapshot until a user action finishes.
        }
    };

    const start = () => {
        if (startPromise) return startPromise;
        startPromise = runStartup();
        return startPromise;
    };

    const runStartup = async () => {
        if (!isDesktopRuntime()) {
            apply(emptyDesktopUpdateState(fallbackVersion), { persistBusy: false, actionBusy: false });
            return;
        }
        const binding = getBinding();
        if (!hasDesktopUpdateBinding(binding)) {
            apply({ ...emptyDesktopUpdateState(fallbackVersion), status: "disabled" });
            return;
        }
        try {
            const initial = parseDesktopUpdateState(await binding.UpdateStatus(), fallbackVersion);
            if (disposed) return;
            const quietInitial = initial.status === "error" ? { ...initial, status: "idle" as const, error: "" } : initial;
            apply(quietInitial);
            if (quietInitial.status === "disabled" || quietInitial.status === "downloading" || quietInitial.status === "ready" || quietInitial.status === "installing") {
                return;
            }
            lastAction = "check";
            apply({ ...quietInitial, status: "checking", error: "" });
            try {
                const next = parseDesktopUpdateState(await binding.CheckForUpdate(), quietInitial.currentVersion || fallbackVersion);
                if (disposed) return;
                apply(next);
            } catch (error) {
                if (disposed) return;
                apply({ ...quietInitial, status: "error", error: bindingErrorMessage(error) || "无法检查更新，请检查网络后重试。" });
            }
        } catch {
            if (disposed) return;
            apply({ ...emptyDesktopUpdateState(fallbackVersion), status: "error", error: "无法检查更新，请重试。" });
        }
    };

    const download = async () => {
        if (actionBusy || persistBusy) return;
        const binding = getBinding();
        if (!hasDesktopUpdateBinding(binding) || runtimeKind() !== "desktop") return;
        if (state.status !== "available" && !(state.status === "error" && (lastAction === "download" || Boolean(state.latestVersion)))) return;
        lastAction = "download";
        actionBusy = true;
        apply({ ...state, status: "downloading", error: "" }, { actionBusy: true });
        try {
            const next = parseDesktopUpdateState(await binding.DownloadUpdate(), state.currentVersion || fallbackVersion);
            if (disposed) return;
            apply(next, { actionBusy: false });
        } catch (error) {
            if (disposed) return;
            apply(
                {
                    ...state,
                    status: "error",
                    error: bindingErrorMessage(error),
                },
                { actionBusy: false },
            );
        }
    };

    const install = async (force = false) => {
        if (actionBusy || persistBusy) return;
        if (force && !canForceInstall) return;
        const binding = getBinding();
        if (!hasDesktopUpdateBinding(binding) || runtimeKind() !== "desktop") return;
        if (state.status !== "ready" && !(state.status === "error" && stagedReady)) return;
        if (pendingPersistence) {
            apply({ ...state, status: "error", error: "上次保存仍未结束，请稍后重试。" });
            return;
        }
        lastAction = "install";
        persistBusy = true;
        canForceInstall = false;
        emit();
        let saveTimer: ReturnType<typeof setTimeout> | undefined;
        try {
            if (force) {
                if (pendingPersistence) throw new DesktopUpdateSaveInProgressError();
                await assertNoActiveSaves();
            } else {
                const save = persistWorkspace();
                pendingPersistence = save;
                // A timeout stops this install attempt, not the editor's write.
                // Keep ownership until settlement; the next attempt must save afresh.
                void save.then(() => { pendingPersistence = null; }, () => { pendingPersistence = null; });
                await Promise.race([
                    save,
                    new Promise<never>((_, reject) => {
                        saveTimer = setTimeout(() => reject(new Error("保存耗时较长，尚未开始安装。请稍后重试。")), options.persistTimeoutMs ?? 60_000);
                    }),
                ]);
            }
        } catch (error) {
            if (!(error instanceof DesktopUpdateSaveInProgressError)) {
                try { await assertNoActiveSaves(); }
                catch (activeError) {
                    if (activeError instanceof DesktopUpdateSaveInProgressError) error = activeError;
                }
            }
            persistBusy = false;
            canForceInstall = !(error instanceof DesktopUpdateSaveInProgressError);
            apply(
                {
                    ...state,
                    status: "error",
                    error: /[\u4e00-\u9fff]/u.test(bindingErrorMessage(error)) ? bindingErrorMessage(error) : "内容没有保存完成，更新没有开始。请稍后再试。",
                },
                { persistBusy: false, actionBusy: false },
            );
            return;
        } finally {
            clearTimeout(saveTimer);
        }
        if (disposed) return;
        persistBusy = false;
        actionBusy = true;
        apply({ ...state, status: "installing", phase: "verifying", completedFiles: 0, totalFiles: 0, installPrepared: false, error: "" }, { persistBusy: false, actionBusy: true });
        try {
            await binding.InstallUpdate();
            if (disposed) return;
            apply({ ...state, status: "installing", error: "" }, { actionBusy: false });
            // A late status read must never turn a started installation into a retry.
            try {
                const latest = await binding.UpdateStatus();
                if (!disposed && (latest.status === "installing" || latest.status === "error")) apply(latest);
            } catch { /* The application may already be exiting; polling remains the fallback. */ }
        } catch (error) {
            if (disposed) return;
            stagedReady = true;
            apply(
                {
                    ...state,
                    status: "error",
                    error: bindingErrorMessage(error),
                },
                { actionBusy: false },
            );
        }
    };

    const retry = async () => {
        if (lastAction === "install" || stagedReady) {
            await install();
            return;
        }
        if (lastAction === "download") {
            await download();
            return;
        }
        startPromise = null;
        lastAction = "check";
        await start();
    };

    const check = async () => {
        if (actionBusy || persistBusy || !(
            state.status === "idle" ||
            state.status === "available" ||
            (state.status === "error" && (lastAction === "check" || lastAction === "none"))
        )) return;
        startPromise = null;
        lastAction = "check";
        await start();
    };

    const downloadAndInstall = async () => {
        if (actionBusy || persistBusy) return;
        if (state.status === "error" && lastAction === "check") await check();
        if (state.status === "available" || (state.status === "error" && lastAction === "download" && !stagedReady)) await download();
        if (state.status === "ready" || (state.status === "error" && stagedReady)) await install();
    };

    return {
        getSnapshot,
        subscribe: (listener) => {
            listeners.add(listener);
            listener(getSnapshot());
            if (shouldPollDesktopUpdate(state.status)) void refreshStatus();
            syncPoll();
            return () => {
                listeners.delete(listener);
                syncPoll();
            };
        },
        start,
        check,
        download,
        install,
        forceInstall: () => install(true),
        downloadAndInstall,
        retry,
        dispose: () => {
            disposed = true;
            pollGeneration += 1;
            stopPoll?.();
            stopPoll = null;
            listeners.clear();
        },
    };
}

let sharedController: DesktopUpdateController | null = null;

export function getSharedDesktopUpdateController(): DesktopUpdateController {
    if (!sharedController) {
        sharedController = createDesktopUpdateController();
    }
    return sharedController;
}

export function resetSharedDesktopUpdateController() {
    sharedController?.dispose();
    sharedController = null;
}
