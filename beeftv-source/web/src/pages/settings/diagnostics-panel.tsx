import { App, Button, Input } from "antd";
import { Select } from "@/components/ui/base/select";
import { Download, X } from "lucide-react";
import { useEffect, useState } from "react";

import { exportDiagnosticBundle, downloadDiagnosticBundle, previewDiagnosticBundle, type DiagnosticExportInput, type DiagnosticPreview } from "@/services/diagnostics/diagnostics-api";
import { getClientDiagnosticSnapshot, getDiagnosticRuntime } from "@/services/diagnostics/client-diagnostics";
import { clearVideoPreviewCache } from "@/services/api/resources";
import { AppModal } from "@/components/ui/product/app-modal";
import { getDesktopAppBinding } from "@/services/desktop-runtime";
import { EnvironmentChecks } from "./environment-checks";

type DiagnosticsPanelProps = {
    taskId?: string;
    projectId?: string;
    open: boolean;
    onClose: () => void;
};

type DiagnosticRange = "15m" | "30m" | "1h" | "24h";

const rangeOptions: { value: DiagnosticRange; label: string }[] = [
    { value: "15m", label: "最近 15 分钟" },
    { value: "30m", label: "最近 30 分钟" },
    { value: "1h", label: "最近 1 小时" },
    { value: "24h", label: "最近 24 小时" },
];

export default function DiagnosticsPanel({ taskId, projectId, open, onClose }: DiagnosticsPanelProps) {
    const { message } = App.useApp();
    const [range, setRange] = useState<DiagnosticRange>("30m");
    const [description, setDescription] = useState("");
    const [preview, setPreview] = useState<DiagnosticPreview | null>(null);
    const [loadingPreview, setLoadingPreview] = useState(false);
    const [exporting, setExporting] = useState(false);
    const [bundleId, setBundleId] = useState("");
    const [clearingPreviews, setClearingPreviews] = useState(false);
	const openUpdateLogs = getDesktopAppBinding()?.OpenUpdateLogDirectory;
	const [updateLogError, setUpdateLogError] = useState("");

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        setLoadingPreview(true);
        void buildInput(range, undefined, taskId, projectId).then(previewDiagnosticBundle)
            .then((result) => {
                if (!cancelled) setPreview(result);
            })
            .catch(() => {
                if (!cancelled) setPreview(null);
            })
            .finally(() => {
                if (!cancelled) setLoadingPreview(false);
            });
        return () => {
            cancelled = true;
        };
    }, [open, projectId, range, taskId]);

    const handleExport = async () => {
        setExporting(true);
        try {
            const download = await exportDiagnosticBundle(await buildInput(range, description, taskId, projectId));
            const saved = await downloadDiagnosticBundle(download);
            if (saved !== "saved") return;
            setBundleId(download.bundleId);
            message.success("诊断包已保存，请连同诊断编号提交给支持人员");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "导出诊断包失败");
        } finally {
            setExporting(false);
        }
    };

    return (
        <AppModal
            open={open}
            centered
            width={560}
            footer={null}
            closable={false}
            keyboard={!exporting}
            mask={{ closable: !exporting }}
            onCancel={() => { if (!exporting) onClose(); }}
            rootClassName="app-spatial-modal diagnostics-modal"
            title={(
                <div className="flex items-center justify-between gap-2">
                    <span>问题诊断</span>
                    <Button type="text" aria-label="关闭问题诊断" disabled={exporting} icon={<X className="size-4" />} onClick={onClose} />
                </div>
            )}
        >
            <div className="max-h-[calc(100dvh-180px)] space-y-5 overflow-y-auto pt-4">
                {open ? <EnvironmentChecks /> : null}
                <div>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <span className="text-sm font-medium">日志范围</span>
                        <Select
                            ariaLabel="日志范围"
                            className="w-full sm:w-60"
                            value={range}
                            options={rangeOptions}
                            onChange={(value) => {
                                const next = rangeOptions.find((option) => option.value === value)?.value;
                                if (next) setRange(next);
                            }}
                        />
                    </div>
                    <p className="mt-3 text-xs leading-5 text-foreground/55" aria-live="polite">
                        {loadingPreview ? "正在读取日志…" : preview ? `包含 ${preview.taskCount} 个生成任务、${preview.apiCallCount} 次媒体请求${preview.assistantTurnCount === undefined ? "" : `、${preview.assistantTurnCount} 轮助手记录`}及前端日志。` : "暂时无法读取记录数量，可继续尝试导出。"}
                    </p>
                    {preview && (preview.willTruncate || Object.values(preview.collectors || {}).some(collector => collector.status !== "complete")) ? <p className="mt-1 text-xs leading-5 text-foreground/55" role="status">部分记录缺失或已达保留上限，诊断包会注明缺失范围；无法保证还原全部经过。</p> : null}
                </div>
                {openUpdateLogs ? <div>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <p className="text-sm font-medium">应用更新日志</p>
                        <Button onClick={() => { setUpdateLogError(""); void openUpdateLogs().catch(() => setUpdateLogError("无法打开日志文件夹，请在存储设置中查看当前目录。")); }}>打开日志文件夹</Button>
                    </div>
                    <p className="mt-1 text-xs leading-5 text-foreground/55">{preview?.updateLog?.status === "available" ? `诊断包将包含 ${preview.updateLog.lines} 条更新记录。` : preview?.updateLog?.status === "unreadable" ? "部分更新日志无法读取，其他信息仍可导出。" : preview?.updateLog?.status === "missing" ? "未找到更新日志，其他信息仍可导出。" : "请选择覆盖更新失败时间的日志范围。"}</p>
                    {preview?.updateLog?.truncated ? <p className="mt-1 text-xs leading-5 text-foreground/55">日志较多，仅包含最近的部分更新记录。</p> : null}
                    <p className="mt-1 text-xs leading-5 text-foreground/55">日志位于当前数据目录，文件名为 update.log。</p>
                    {updateLogError ? <p className="mt-1 text-xs leading-5 text-destructive" role="alert">{updateLogError}</p> : null}
                </div> : null}
                <div>
                    <label className="mb-3 block text-sm font-medium" htmlFor="diagnostic-description">
                        问题描述 <span className="ml-1 text-xs font-normal text-foreground/55">可选</span>
                    </label>
                    <Input.TextArea id="diagnostic-description" rows={3} maxLength={1000} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="例如：生成一直停在处理中。" />
                </div>
                <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0">
                        <p className="text-sm font-medium">视频预览缓存</p>
                        <p className="mt-1 text-xs leading-5 text-foreground/55">清理预览以释放空间，原文件保留。</p>
                    </div>
                    <Button className="shrink-0" loading={clearingPreviews} onClick={async () => {
                        setClearingPreviews(true);
                        try { const result = await clearVideoPreviewCache(); message.success(`已清理 ${result.cleared} 个视频预览`); }
                        catch (error) { message.error(error instanceof Error ? error.message : "清理失败，请重试"); }
                        finally { setClearingPreviews(false); }
                    }}>清理预览缓存</Button>
                </div>
                <div>
                    <div className="flex items-center justify-between gap-4">
                        <p className="min-w-0 text-xs leading-5 text-foreground/55">诊断包不包含密钥、Cookie 等隐私或原始媒体</p>
                        <Button className="shrink-0" type="primary" icon={<Download className="size-4" />} loading={exporting} onClick={() => void handleExport()}>导出诊断包</Button>
                    </div>
                    {bundleId ? <p className="mt-3 break-all text-xs text-foreground/65" role="status">诊断编号：{bundleId}</p> : null}
                </div>
            </div>
        </AppModal>
    );
}

async function buildInput(range: DiagnosticRange, description: string | undefined, taskId?: string, projectId?: string): Promise<DiagnosticExportInput> {
    const to = new Date();
    const from = new Date(to.getTime() - rangeMilliseconds(range));
    const snapshot = await getClientDiagnosticSnapshot({ from, to });
    return {
        from: from.toISOString(),
        to: to.toISOString(),
        taskId: taskId || undefined,
        projectId: projectId || undefined,
        description: description || undefined,
        runtime: getDiagnosticRuntime(),
        clientEvents: snapshot.events,
        clientCoverage: snapshot.coverage,
    };
}

function rangeMilliseconds(range: DiagnosticRange) {
    switch (range) {
        case "15m":
            return 15 * 60 * 1000;
        case "1h":
            return 60 * 60 * 1000;
        case "24h":
            return 24 * 60 * 60 * 1000;
        default:
            return 30 * 60 * 1000;
    }
}
