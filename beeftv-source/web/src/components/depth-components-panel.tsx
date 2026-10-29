import { useCallback, useEffect, useState } from "react";
import { Button, Progress, type App } from "antd";
import { getDesktopAppBinding, type DepthComponentState } from "@/services/desktop-runtime";
import { navigateToSettings } from "@/lib/settings-navigation";

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
const running = (state?: DepthComponentState) => state?.status === "downloading" || state?.status === "installing";
const statusText: Record<DepthComponentState["status"], string> = {
    not_installed: "尚未安装", downloading: "正在下载", installing: "正在解压并安装", ready: "已安装，可以使用",
    paused: "下载已暂停", error: "安装未完成", unsupported: "当前设备暂不支持",
};

export function DepthComponentsPanel({ initialState, onReady, onCancel, onOpenSettings }: { initialState?: DepthComponentState; onReady?: () => void; onCancel?: () => Promise<void>; onOpenSettings?: () => void }) {
    const binding = getDesktopAppBinding();
    const [state, setState] = useState(initialState);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const refresh = useCallback(async (force = false) => {
        try {
            if (!binding?.DepthComponentStatus) throw new Error("请在 BeefTV 桌面版中管理本地组件");
            setState(await binding.DepthComponentStatus(force));
            setError("");
        } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    }, [binding]);
    useEffect(() => { if (!initialState) void refresh(); }, [initialState, refresh]);
    useEffect(() => {
        if (!running(state)) return;
        const timer = window.setInterval(() => void refresh(), 1000);
        return () => window.clearInterval(timer);
    }, [state?.status, refresh]);
    useEffect(() => { if (state?.status === "ready") onReady?.(); }, [state?.status, onReady]);
    const mutate = async (action?: () => Promise<DepthComponentState>) => {
        if (!action) return;
        setBusy(true);
        try { setState(await action()); setError(""); }
        catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
        finally { setBusy(false); }
    };
    const insufficient = Boolean(state && state.status !== "ready" && state.freeBytes < state.requiredBytes);
    return <div className="space-y-3 text-sm" data-canvas-no-zoom data-canvas-wheel-scroll>
        <p className="leading-6 text-foreground/70">视频在本机处理，确认后才会下载所需组件和模型。</p>
        <p role="status">{state ? statusText[state.status] : error ? "组件信息暂时无法读取" : "正在检查组件信息…"}</p>
        {state && state.status !== "unsupported" ? <>
            <div className="space-y-1 leading-6">
                <p className="break-all">存放位置：{state.dataDir}</p>
                {state.status !== "ready" ? <p>下载约 {gb(state.downloadBytes)}，需预留 {gb(state.requiredBytes)}，当前可用 {gb(state.freeBytes)}</p> : null}
                <p className="text-foreground/60">{state.variant === "cuda" ? "使用 NVIDIA 显卡加速" : state.variant === "cpu" ? "使用 CPU 处理，耗时可能较长" : "使用 Apple 芯片加速"}</p>
            </div>
            {running(state) ? <>
                <Progress percent={Math.min(99, Math.floor(state.downloadedBytes / Math.max(1, state.downloadBytes) * 100))} status="active" aria-label="组件下载进度" />
                <p className="text-foreground/60">{gb(state.downloadedBytes)} / {gb(state.downloadBytes)}。暂停后可继续下载；退出应用后不会自行恢复。</p>
            </> : null}
            {insufficient && !running(state) ? <p role="alert" className="text-destructive">空间不足，请先更换目录或清理磁盘。</p> : null}
            <div className="flex flex-wrap gap-2">
                {running(state) ? <Button loading={busy} onClick={() => void mutate(binding?.PauseDepthComponentDownload)}>暂停下载</Button> : state.status !== "ready" ? <Button type="primary" loading={busy} disabled={insufficient} onClick={() => void mutate(binding?.DownloadDepthComponents)}>{state.status === "paused" || state.status === "error" ? "继续下载" : onReady ? "下载并继续" : "下载组件"}</Button> : null}
                {onOpenSettings && !running(state) ? <Button onClick={onOpenSettings}>前往存储设置</Button> : null}
                {!onReady && !running(state) ? <Button disabled={busy} onClick={() => void refresh(true)}>重新检查</Button> : null}
                {onCancel ? <Button disabled={busy} onClick={async () => {
                    setBusy(true);
                    try { await onCancel(); } catch(cause) { setError(cause instanceof Error ? cause.message : String(cause)); setBusy(false); }
                }}>{running(state) ? "暂停并返回" : "暂不下载"}</Button> : null}
            </div>
        </> : null}
        {error || state?.error ? <p role="alert" className="break-words text-destructive">{error || state?.error}</p> : null}
        {!state && error ? <Button onClick={() => void refresh(true)}>重新检查</Button> : null}
    </div>;
}

type ModalAPI = ReturnType<typeof App.useApp>["modal"];

export async function confirmDepthComponents(modal: ModalAPI): Promise<boolean> {
    const binding = getDesktopAppBinding();
    if (!binding?.DepthComponentStatus) throw new Error("请先在 BeefTV 桌面版的存储设置中安装深度捕捉组件");
    const state = await binding.DepthComponentStatus(true);
    if (state.status === "ready") return true;
    return new Promise<boolean>((resolve) => {
        let settled = false;
        let cancelRequested = false;
        const finish = (allowed: boolean) => { if (!settled) { settled = true; resolve(allowed); } };
        const cancel = async () => {
            // A download finishing during cancellation must not launch the task.
            cancelRequested = true;
            await binding.PauseDepthComponentDownload?.();
            dialog.destroy();
            finish(false);
        };
        const dialog = modal.confirm({
            title: "准备深度动作捕捉", centered: true, closable: true, maskClosable: false, width: 560, footer: null, icon: null,
            content: <DepthComponentsPanel initialState={state} onReady={() => { if (!cancelRequested) { dialog.destroy(); finish(true); } }} onCancel={cancel} onOpenSettings={() => { finish(false); dialog.destroy(); navigateToSettings({ section: "storage" }); }} />,
            onCancel: cancel,
        });
    });
}
