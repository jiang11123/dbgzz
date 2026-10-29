import { Bot, LoaderCircle, Plus, RefreshCw, Trash2 } from "lucide-react";
import { App, Popover, Switch } from "antd";
import { useRef, useState } from "react";

import { doubaoAccountStatusMeta, useDoubaoAccounts } from "@/hooks/use-doubao-accounts";
import { confirmDeleteDoubaoAccount, requestAddDoubaoAccount, type DoubaoGatewayAccount } from "@/services/api/doubao-gateway";
import { useDoubaoPreferencesStore } from "@/stores/use-doubao-preferences-store";

/**
 * 豆包 3.0：工作区侧栏的豆包账号徽标。
 * 展示在线账号概况；弹层内可查看各账号健康状态、扫码添加新账号。
 * 账号池由后台隐身运行的豆包工作站维护，扫码登录后轮询自动刷新。
 */
export function DoubaoAccountBadge() {
    const { message } = App.useApp();
    const showDoubaoNodes = useDoubaoPreferencesStore((state) => state.showDoubaoNodes);
    const setShowDoubaoNodes = useDoubaoPreferencesStore((state) => state.setShowDoubaoNodes);
    const { accounts, loading, gatewayOffline, refresh } = useDoubaoAccounts();
    const [deletingId, setDeletingId] = useState<number | null>(null);
    const deletingRef = useRef(false);
    const onlineCount = accounts.filter((account) => account.isLoggedIn !== false && account.status === "healthy").length;

    const deleteAccount = async (account: DoubaoGatewayAccount) => {
        if (deletingRef.current) return;
        deletingRef.current = true;
        setDeletingId(account.id);
        try {
            if (!await confirmDeleteDoubaoAccount(account.id)) return;
            await refresh();
            message.success(`已删除 ${account.name}`);
        } catch (cause) {
            message.error(cause instanceof Error ? cause.message : "删除账号失败");
        } finally {
            deletingRef.current = false;
            setDeletingId(null);
        }
    };

    const addAccount = async () => {
        try {
            await requestAddDoubaoAccount();
            message.success("已唤起豆包工作站扫码窗口，请用手机豆包 App 扫码登录");
            void refresh();
        } catch (cause) {
            message.error(cause instanceof Error ? cause.message : "添加账号失败");
        }
    };

    return (
        <Popover
            trigger={["click"]}
            placement="bottomLeft"
            title="豆包账号"
            content={
                <div className="flex w-60 flex-col gap-0.5">
                    {gatewayOffline && <span className="px-2 py-1 text-xs text-amber-500">豆包工作站网关未连接，生成功能暂不可用</span>}
                    {!gatewayOffline && accounts.length === 0 && <span className="px-2 py-1 text-xs text-neutral-400">{loading ? "加载中…" : "暂无豆包账号"}</span>}
                    {accounts.map((account) => {
                        const meta = doubaoAccountStatusMeta(account.isLoggedIn === false ? "logged_out" : account.status);
                        return (
                            <div key={account.id} className="flex items-center gap-2 rounded px-2 py-1.5 text-xs">
                                <span className="inline-block size-1.5 shrink-0 rounded-full" style={{ background: meta.color }} />
                                <span className="flex-1 truncate">{account.name}</span>
                                <span className="shrink-0 text-[10px] opacity-60">{meta.label}</span>
                                <button
                                    type="button"
                                    aria-label={`删除账号 ${account.name}`}
                                    title={account.busy ? "账号正在执行任务，请完成后再删除" : accounts.length <= 1 ? "至少保留一个账号" : `删除 ${account.name}`}
                                    disabled={deletingId !== null || account.busy || accounts.length <= 1}
                                    className="grid size-6 shrink-0 place-items-center rounded text-foreground/50 transition-colors hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-30"
                                    onClick={() => void deleteAccount(account)}
                                >
                                    {deletingId === account.id ? <LoaderCircle className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                                </button>
                            </div>
                        );
                    })}
                    <button type="button" className="mt-1 flex items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-black/5" onClick={() => void addAccount()}>
                        <Plus className="size-3" />
                        添加豆包账号（扫码）
                    </button>
                    <div className="my-1 border-t border-border px-2 pt-2">
                        <div className="flex items-center justify-between gap-3 text-xs">
                            <span id="doubao-node-visibility-label">显示独立豆包节点</span>
                            <Switch size="small" aria-labelledby="doubao-node-visibility-label" checked={showDoubaoNodes} onChange={setShowDoubaoNodes} />
                        </div>
                        <p className="mt-1.5 text-[11px] leading-relaxed text-foreground/50">显示豆包文字、图片、视频节点。原始节点中始终可以选择豆包账号。</p>
                    </div>
                    <button type="button" className="flex items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-black/5" onClick={() => void refresh()}>
                        <RefreshCw className={`size-3 ${loading ? "animate-spin" : ""}`} />
                        刷新账号列表
                    </button>
                </div>
            }
        >
            <button
                type="button"
                aria-label="豆包账号管理"
                title={gatewayOffline ? "豆包工作站未连接" : `豆包账号 ${onlineCount}/${accounts.length} 在线`}
                className="app-workspace-topbar-icon-button relative grid size-8 shrink-0 place-items-center rounded-[var(--r-sm)] transition-colors hover:bg-black/5"
                style={gatewayOffline ? undefined : { color: onlineCount > 0 ? "#00b96b" : "#faad14" }}
            >
                <Bot className="size-4" strokeWidth={1.7} />
                {!gatewayOffline && accounts.length > 0 && (
                    <span className="absolute -right-0.5 -top-0.5 grid min-w-3.5 place-items-center rounded-full bg-[#00b96b] px-0.5 text-[9px] font-semibold leading-3.5 text-white">
                        {onlineCount}
                    </span>
                )}
            </button>
        </Popover>
    );
}
