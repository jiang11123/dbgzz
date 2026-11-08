import { Bot, Edit2, LoaderCircle, Plus, RefreshCw, Trash2 } from "lucide-react";
import { App, Input, Modal, Popover, Switch } from "antd";
import { useRef, useState } from "react";

import { doubaoAccountStatusMeta, useDoubaoAccounts } from "@/hooks/use-doubao-accounts";
import { confirmDeleteDoubaoAccount, requestAddDoubaoAccount, updateDoubaoAccount, type DoubaoGatewayAccount } from "@/services/api/doubao-gateway";
import { useDoubaoPreferencesStore } from "@/stores/use-doubao-preferences-store";

/**
 * 豆包 3.0：工作区侧栏的豆包账号徽标。
 * 展示在线账号概况；弹层内可查看各账号健康状态、修改备注与名称、扫码添加新账号。
 * 账号池由后台隐身运行的豆包工作站维护，扫码登录后轮询自动刷新。
 */
export function DoubaoAccountBadge() {
    const { message } = App.useApp();
    const showDoubaoNodes = useDoubaoPreferencesStore((state) => state.showDoubaoNodes);
    const setShowDoubaoNodes = useDoubaoPreferencesStore((state) => state.setShowDoubaoNodes);
    const autoConfirmVideo = useDoubaoPreferencesStore((state) => state.autoConfirmVideo);
    const setAutoConfirmVideo = useDoubaoPreferencesStore((state) => state.setAutoConfirmVideo);
    const { accounts, loading, gatewayOffline, refresh } = useDoubaoAccounts();
    const [deletingId, setDeletingId] = useState<number | null>(null);
    const deletingRef = useRef(false);

    // 修改备注与名称弹窗状态
    const [editingAccount, setEditingAccount] = useState<DoubaoGatewayAccount | null>(null);
    const [nameDraft, setNameDraft] = useState("");
    const [noteDraft, setNoteDraft] = useState("");
    const [saving, setSaving] = useState(false);

    const onlineCount = accounts.filter((account) => account.isLoggedIn !== false && account.status === "healthy").length;

    const startEdit = (account: DoubaoGatewayAccount) => {
        setEditingAccount(account);
        setNameDraft(account.name);
        setNoteDraft(account.note || "");
    };

    const saveEdit = async () => {
        if (!editingAccount) return;
        const name = nameDraft.trim();
        if (!name) {
            message.error("账号名称不能为空");
            return;
        }
        setSaving(true);
        try {
            await updateDoubaoAccount(editingAccount.id, { name, note: noteDraft.trim() });
            message.success(`已更新【${name}】备注与名称`);
            setEditingAccount(null);
            await refresh();
        } catch (cause) {
            message.error(cause instanceof Error ? cause.message : "更新失败");
        } finally {
            setSaving(false);
        }
    };

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
            message.success("已唤起豆包工作站扫码窗口，扫码后可在列表直接点击铅笔按钮修改备注");
            void refresh();
        } catch (cause) {
            message.error(cause instanceof Error ? cause.message : "添加账号失败");
        }
    };

    return (
        <>
            <Popover
                trigger={["click"]}
                placement="bottomLeft"
                title="豆包账号"
                content={
                    <div className="flex w-72 flex-col gap-0.5">
                        {gatewayOffline && <span className="px-2 py-1 text-xs text-amber-500">豆包工作站网关未连接，生成功能暂不可用</span>}
                        {!gatewayOffline && accounts.length === 0 && <span className="px-2 py-1 text-xs text-neutral-400">{loading ? "加载中…" : "暂无豆包账号"}</span>}
                        {accounts.map((account) => {
                            const meta = doubaoAccountStatusMeta(account.isLoggedIn === false ? "logged_out" : account.status);
                            return (
                                <div key={account.id} className="flex items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-black/5">
                                    <span className="inline-block size-1.5 shrink-0 rounded-full" style={{ background: meta.color }} />
                                    <div className="flex min-w-0 flex-1 flex-col">
                                        <div className="flex items-center gap-1 truncate">
                                            <span className="font-medium truncate">{account.name}</span>
                                            {account.note ? (
                                                <span className="shrink-0 rounded bg-emerald-500/15 px-1 py-0.5 text-[10px] text-emerald-500 font-normal">
                                                    {account.note}
                                                </span>
                                            ) : null}
                                        </div>
                                    </div>
                                    <span className="shrink-0 text-[10px] opacity-60">{meta.label}</span>
                                    <button
                                        type="button"
                                        aria-label={`修改账号 ${account.name} 备注与名称`}
                                        title="修改备注与名称"
                                        className="grid size-6 shrink-0 place-items-center rounded text-foreground/50 transition-colors hover:bg-primary/10 hover:text-primary"
                                        onClick={() => startEdit(account)}
                                    >
                                        <Edit2 className="size-3.5" />
                                    </button>
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
                        <button type="button" className="mt-1 flex items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-black/5 font-medium text-primary" onClick={() => void addAccount()}>
                            <Plus className="size-3.5" />
                            添加豆包账号（扫码）
                        </button>
                        <div className="my-1 border-t border-border px-2 pt-2">
                            <div className="flex items-center justify-between gap-3 text-xs">
                                <span id="doubao-node-visibility-label">显示独立豆包节点</span>
                                <Switch size="small" aria-labelledby="doubao-node-visibility-label" checked={showDoubaoNodes} onChange={setShowDoubaoNodes} />
                            </div>
                            <p className="mt-1 text-[11px] leading-relaxed text-foreground/50">显示豆包文字、图片、视频节点。原始节点中始终可以选择豆包账号。</p>
                        </div>
                        <div className="my-1 border-t border-border px-2 pt-2">
                            <div className="flex items-center justify-between gap-3 text-xs">
                                <span id="doubao-auto-confirm-label" className="font-medium">视频生成自动确认</span>
                                <Switch size="small" aria-labelledby="doubao-auto-confirm-label" checked={autoConfirmVideo} onChange={setAutoConfirmVideo} />
                            </div>
                            <p className="mt-1 text-[11px] leading-relaxed text-foreground/50">{autoConfirmVideo ? "开启：遇豆包询问是否确认时，检测到会自动确定继续生成。" : "关闭：遇确认询问时停在画板，需要自己手动确认。"}</p>
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

            {editingAccount && (
                <Modal
                    title="修改豆包账号备注与名称"
                    open={Boolean(editingAccount)}
                    onOk={saveEdit}
                    onCancel={() => setEditingAccount(null)}
                    confirmLoading={saving}
                    okText="保存并同步"
                    cancelText="取消"
                    destroyOnClose
                    width={380}
                >
                    <div className="flex flex-col gap-3 py-2 text-xs">
                        <div>
                            <label className="mb-1 block font-medium opacity-75">账号名称</label>
                            <Input
                                value={nameDraft}
                                onChange={(e) => setNameDraft(e.target.value)}
                                placeholder="例如：主号、生图A、账号1"
                            />
                        </div>
                        <div>
                            <label className="mb-1 block font-medium opacity-75">账号备注</label>
                            <Input
                                value={noteDraft}
                                onChange={(e) => setNoteDraft(e.target.value)}
                                placeholder="例如：主力生图、138****0000、剧本大纲"
                                autoFocus
                                onPressEnter={saveEdit}
                            />
                            <span className="mt-1 block text-[11px] opacity-50">
                                备注将显示在右上角账号列表、画布节点及模型选择框中
                            </span>
                        </div>
                    </div>
                </Modal>
            )}
        </>
    );
}
