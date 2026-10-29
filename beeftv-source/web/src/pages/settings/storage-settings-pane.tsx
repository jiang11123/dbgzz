import { useEffect, useState } from "react";
import { App, Button, Input } from "antd";
import { FolderOpen } from "lucide-react";
import { getDesktopAppBinding, type DesktopStorageUsage } from "@/services/desktop-runtime";
import { flushModelConfig, getModelConfigPersistenceState } from "@/services/model-config-repository";
import { saveRemoteUserDataNow } from "@/services/local-workspace-sync";
import { recordDiagnosticEvent } from "@/services/diagnostics/client-diagnostics";
import { startOperation } from "@/stores/use-operation-progress";
import { createTransferSampler } from "@/lib/operation-progress";

const size = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

export function StorageSettingsPane() {
    const { message, modal } = App.useApp();
    const binding = getDesktopAppBinding();
    const [usage, setUsage] = useState<DesktopStorageUsage>();
    const [target, setTarget] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [cleanupInterrupted, setCleanupInterrupted] = useState(false);
    const [errorSummary, ...errorDetails] = error.split("\n\n");
    useEffect(() => {
        let active = true;
        void binding
            ?.StorageSettings?.()
            .then((value) => {
                if (active) setUsage(value);
            })
            .catch(() => {
                if (active) setError("存储信息暂时无法读取，请重试");
            });
        return () => {
            active = false;
        };
    }, [binding]);
    if (!binding?.StorageSettings || !binding.MigrateStorage) return null;
    const choose = async () => {
        try {
            const path = await binding.ChooseStorageDirectory?.();
            if (path) setTarget(path);
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        }
    };
    const migrate = async () => {
        setBusy(true);
        setError("");
        let phase = "save_workspace";
        const progress = startOperation("迁移存储目录", { detail: "正在保存工作区" });
        const sample = createTransferSampler();
        let stopped = false;
        let pollTimer: ReturnType<typeof setTimeout> | undefined;
        const poll = async () => {
            try {
                const state = await binding.StorageMigrationStatus?.();
                if (!stopped && state?.phase) progress.update({ ...sample(state.loadedBytes, state.totalBytes), ...state });
            } catch { /* Migration closes the workspace API; Wails polling resumes on the next tick. */ }
            if (!stopped) pollTimer = setTimeout(poll, 500);
        };
        recordDiagnosticEvent({ level: "info", category: "action", code: "storage_migration_started", message: "开始准备存储迁移" });
        try {
            await Promise.all([flushModelConfig(), saveRemoteUserDataNow()]);
            const state = getModelConfigPersistenceState();
            if (state.dirty || state.status === "error") throw new Error("模型配置尚未保存，请先解决保存错误再迁移");
            phase = "migrate_workspace";
            void poll();
            await binding.MigrateStorage!(target.trim());
            progress.done("迁移完成，正在重新载入");
            window.location.reload();
        } catch (error) {
            progress.fail("迁移未完成，请查看下方错误详情");
            const details = error instanceof Error ? error.message : String(error);
            recordDiagnosticEvent({ level: "error", category: "action", code: "storage_migration_failed", reason: phase, message: details });
            setError(details);
            setBusy(false);
        } finally {
            stopped = true;
            if (pollTimer) clearTimeout(pollTimer);
        }
    };
    const cleanup = () =>
        modal.confirm({
            title: "清理原目录",
            centered: true,
            okText: "确认并清理",
            cancelText: "取消",
            content: (
                <p className="break-words">
                    请先确认当前项目、素材和模型配置可以正常使用。清理 {usage?.previousDir} 可释放约 {size(usage?.previousBytes || 0)}；清理后无法从此目录恢复。
                </p>
            ),
            onOk: async () => {
                setBusy(true);
                setError("");
                try {
                    setUsage(await binding.CleanupPreviousStorage!());
                    setCleanupInterrupted(false);
                    message.success("原目录已清理");
                } catch (error) {
                    setCleanupInterrupted(true);
                    setError(error instanceof Error ? error.message : String(error));
                    // Cleanup may have removed durable copies while leaving busy scratch.
                    try {
                        setUsage(await binding.StorageSettings!());
                    } catch {
                        /* Keep the last known usage. */
                    }
                } finally {
                    setBusy(false);
                }
            },
        });
    return (
        <section className="settings-section storage-settings-block space-y-4" aria-label="本地存储">
            <div className="settings-pane-header">
                <div className="min-w-0">
                    <h2>本地存储</h2>
                </div>
            </div>
            <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 text-sm">
                <div className="min-w-0 break-all">当前目录：{usage?.dataDir || "正在读取…"}</div>
                {usage ? (
                    <p className="shrink-0 text-foreground/60">
                        数据占用 {size(usage.usedBytes)} · 磁盘剩余 {size(usage.freeBytes)}
                    </p>
                ) : null}
            </div>
            <label className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="shrink-0 text-sm">新存储目录：</span>
                <div className="flex min-w-0 flex-1 flex-wrap gap-2">
                    <Input className="min-w-0 flex-1" aria-label="新存储目录" value={target} onChange={(event) => setTarget(event.target.value)} placeholder="例如 D:\BeefTV" disabled={busy} />
                    <Button icon={<FolderOpen className="size-4" />} onClick={choose} disabled={busy}>
                        选择文件夹
                    </Button>
                </div>
            </label>
            <p className="text-sm leading-6 text-foreground/60">请选择空文件夹。迁移期间请暂停操作；完成后会重新载入。原目录会保留，请确认项目和素材完整后再清理。</p>
            {error ? (
                <div role="alert" className="text-sm text-destructive break-words">
                    <p>{errorSummary}</p>
                    {errorDetails.length > 0 ? (
                        <details className="mt-2">
                            <summary className="cursor-pointer">错误详情</summary>
                            <p className="mt-2 break-all whitespace-pre-wrap">{errorDetails.join("\n\n")}</p>
                        </details>
                    ) : null}
                </div>
            ) : null}
            <Button type="primary" onClick={migrate} loading={busy} disabled={!usage || !target.trim() || target.trim() === usage.dataDir}>
                {busy ? "正在迁移并校验文件…" : "迁移旧数据并使用新目录"}
            </Button>
            {usage?.previousDir && binding.CleanupPreviousStorage ? (
                <div className="space-y-2 border-t border-border pt-4">
                    <p className="text-sm break-all">待清理的原目录：{usage.previousDir}。</p>
                    {cleanupInterrupted ? <p className="text-sm">清理未完成，原目录可能已部分清理。请保留当前存储目录。</p> : null}
                    <Button danger disabled={busy} onClick={cleanup}>
                        清理原目录，释放磁盘空间
                    </Button>
                </div>
            ) : null}
        </section>
    );
}
