import { Bot, CircleAlert, Image as ImageIcon, LoaderCircle, MessageSquareText, Play, Plus, RefreshCw, Send, Square, Video } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App, Progress, Select, Slider } from "antd";

import { useDoubaoAccounts, doubaoAccountStatusMeta } from "@/hooks/use-doubao-accounts";
import { imageToDataUrl } from "@/services/image-storage";
import {
    doubaoCancelVideoTask,
    doubaoChatCompletion,
    doubaoConfirmVideoTask,
    doubaoFetchTaskLastFrame,
    doubaoFetchTaskVideo,
    doubaoGenerateImage,
    doubaoPollVideoTask,
    doubaoSubmitVideoTask,
    gatewaySignal,
    requestAddDoubaoAccount,
} from "@/services/api/doubao-gateway";
import type { CanvasTheme } from "@/lib/canvas-theme";
import { CanvasNodeType, type CanvasNodeData, type DoubaoAccountNodeState, type DoubaoNodeRunStatus, type DoubaoNodeTaskMode } from "@/types/canvas";

import { useCanvasNodeActions } from "../canvas-node-action-context";
import { useUpstreamNodes } from "../canvas-node-graph-context";

type DoubaoAccountNodeContentProps = {
    node: CanvasNodeData;
    theme: CanvasTheme;
};

const IMAGE_RATIOS = ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3"];
const VIDEO_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4"];
// 与旧工作站统一会话参数一致：doubao-video.ts VIDEO_MODELS + 豆包站点 4-30s 时长滑杆
const VIDEO_MODELS = ["Seedance 2.5", "Seedance 2.0", "Seedance 2.0 Fast", "Seedance 2.0 Mini"];
const DEFAULT_VIDEO_MODEL = "Seedance 2.5";
const MIN_DURATION = 4;
const MAX_DURATION = 30;

const MODE_META: Record<DoubaoNodeTaskMode, { label: string; icon: typeof Bot }> = {
    chat: { label: "对话", icon: MessageSquareText },
    image: { label: "生图", icon: ImageIcon },
    video: { label: "生视频", icon: Video },
};

const DEFAULT_STATE: DoubaoAccountNodeState = { schemaVersion: 1, mode: "chat", prompt: "", status: "idle" };

const NODE_MODES = Object.keys(MODE_META) as DoubaoNodeTaskMode[];
const RUN_STATUSES: DoubaoNodeRunStatus[] = ["idle", "running", "success", "error", "needs_attention", "cancelled"];
const POLL_INTERVAL_MS = 2500;
// 视频任务总上限：超时后停止轮询并提示人工确认，避免节点永久停在“生成中”。
const VIDEO_TASK_MAX_MS = 10 * 60 * 1000;
const CHAT_TIMEOUT_MS = 5 * 60 * 1000;
const IMAGE_TIMEOUT_MS = 3 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

/** 持久化数据可能来自旧版本/同步合并，mode 或 status 缺失时回落默认值，防止渲染期 TypeError。 */
function normalizeNodeState(raw?: DoubaoAccountNodeState): DoubaoAccountNodeState {
    if (!raw || typeof raw !== "object") return DEFAULT_STATE;
    return {
        ...raw,
        mode: NODE_MODES.includes(raw.mode) ? raw.mode : DEFAULT_STATE.mode,
        status: RUN_STATUSES.includes(raw.status) ? raw.status : "idle",
    };
}

/** 豆包账号节点：账号绑定 + 任务模式 + 提示词 + 自执行。结果物化为原生图片/视频子节点。 */
export function DoubaoAccountNodeContent({ node, theme }: DoubaoAccountNodeContentProps) {
    const { message } = App.useApp();
    const { updateNode, addDoubaoResultNode } = useCanvasNodeActions();
    const upstream = useUpstreamNodes(node.id);
    const { accounts, loading, refreshing, gatewayOffline, error, refresh } = useDoubaoAccounts();
    const state = normalizeNodeState(node.metadata?.doubaoAccountNode);
    const [promptDraft, setPromptDraft] = useState(state.prompt);
    const [previewUrl, setPreviewUrl] = useState("");
    // 豆包生成前要求确认参数/补充材料或返回回复时，把它的原文展示出来，
    // 用户可直接输入回复并发送转交回豆包页面。
    const [confirmQuestion, setConfirmQuestion] = useState(state.latestReply || "");
    const [supplementDraft, setSupplementDraft] = useState("");
    const [sendingSupplement, setSendingSupplement] = useState(false);
    // activeRef 覆盖整个 run 生命周期（含轮询/下载），cancel 与卸载都会复位；
    // 它是“迟到的响应是否还允许写状态”的唯一判据。
    const activeRef = useRef(false);
    const abortRef = useRef<AbortController | null>(null);
    const previewObjectUrlRef = useRef("");

    useEffect(() => setPromptDraft(state.prompt), [state.prompt]);
    useEffect(() => {
        if (state.latestReply) setConfirmQuestion(state.latestReply);
    }, [state.latestReply]);
    const setPreviewObjectUrl = useCallback((url: string) => {
        if (previewObjectUrlRef.current && previewObjectUrlRef.current !== url) URL.revokeObjectURL(previewObjectUrlRef.current);
        previewObjectUrlRef.current = url;
        setPreviewUrl(url);
    }, []);
    useEffect(() => () => {
        activeRef.current = false;
        abortRef.current?.abort();
        if (previewObjectUrlRef.current) URL.revokeObjectURL(previewObjectUrlRef.current);
    }, []);

    const patchState = useCallback((patch: Partial<DoubaoAccountNodeState>) => {
        if (!updateNode) return;
        updateNode(node.id, (current) => ({
            ...current,
            metadata: {
                ...current.metadata,
                doubaoAccountNode: { ...(current.metadata?.doubaoAccountNode || DEFAULT_STATE), ...patch, schemaVersion: 1 },
            },
        }));
    }, [node.id, updateNode]);

    const account = accounts.find((item) => item.id === state.accountId);
    const accountMeta = account ? doubaoAccountStatusMeta(account.status) : undefined;
    const busy = state.status === "running";
    const isWaitingReply = busy && (
        Boolean(confirmQuestion) ||
        Boolean(state.latestReply) ||
        state.statusText?.includes("等待你的回复") ||
        state.statusText?.includes("补充消息") ||
        state.statusText?.includes("继续发送")
    );
    const displayReply = confirmQuestion || state.latestReply || "";

    // 自动适配节点尺寸：当出现豆包回复或等待交互时，若节点高度过小则自动拓展，避免内容被挤压截断
    useEffect(() => {
        if (!updateNode) return;
        const targetHeight = state.mode === "video" ? 520 : state.mode === "image" ? 440 : 400;
        const targetWidth = state.mode === "video" ? 440 : 380;
        if ((isWaitingReply || Boolean(displayReply)) && (node.height < targetHeight || node.width < targetWidth)) {
            updateNode(node.id, (current) => ({
                ...current,
                height: Math.max(current.height || 0, targetHeight),
                width: Math.max(current.width || 0, targetWidth),
            }));
        }
    }, [isWaitingReply, displayReply, node.height, node.id, node.width, state.mode, updateNode]);

    // 如果节点标题仍为旧的通用名称“豆包账号”，自动迁移为该模式的专用标题
    useEffect(() => {
        if (!updateNode) return;
        if (!node.title || node.title === "豆包账号") {
            const defaultTitle = state.mode === "image" ? "豆包图片" : state.mode === "video" ? "豆包视频" : "豆包文字";
            updateNode(node.id, (current) => ({
                ...current,
                title: defaultTitle,
            }));
        }
    }, [node.id, node.title, state.mode, updateNode]);

    const upstreamText = useMemo(
        () => upstream
            .filter((item) => item.type === CanvasNodeType.Text || item.type === CanvasNodeType.Markdown)
            .map((item) => item.metadata?.content || item.metadata?.prompt || "")
            .filter(Boolean)
            .join("\n\n"),
        [upstream],
    );

    const composePrompt = useCallback(() => {
        const base = promptDraft.trim();
        return upstreamText ? `${base}\n\n${upstreamText}` : base;
    }, [promptDraft, upstreamText]);

    const collectReferenceDataUrls = useCallback(async (): Promise<string[]> => {
        const imageNodes = upstream.filter((item) => item.type === CanvasNodeType.Image || item.type === CanvasNodeType.Drawing);
        const dataUrls: string[] = [];
        for (const imageNode of imageNodes) {
            try {
                const contentUrl = imageNode.metadata?.content || imageNode.metadata?.previewContent || "";
                const dataUrl = await imageToDataUrl({
                    url: contentUrl,
                    dataUrl: contentUrl.startsWith("data:") ? contentUrl : undefined,
                    storageKey: imageNode.metadata?.storageKey,
                });
                if (dataUrl) dataUrls.push(dataUrl);
            } catch {
                // 单个参考素材读取失败时跳过，不让整个任务失败
            }
        }
        return dataUrls;
    }, [upstream]);

    const pollVideo = useCallback(async (taskId: string) => {
        activeRef.current = true;
        // 整个轮询会话共用一个 AbortController：cancel/卸载 abort 一次即可终止全部在途请求，
        // 不再被下一轮新建的 controller 覆盖（旧实现会让取消在 sleep 窗口失效）。
        const controller = abortRef.current ?? new AbortController();
        abortRef.current = controller;
        let startedAt = Date.now();
        try {
            for (;;) {
                if (!activeRef.current) return;
                if (Date.now() - startedAt > VIDEO_TASK_MAX_MS) {
                    patchState({ status: "error", statusText: "", error: "视频生成超时（超过 10 分钟），请到豆包账号页确认结果后重试" });
                    return;
                }
                const task = await doubaoPollVideoTask(taskId, gatewaySignal(controller, POLL_INTERVAL_MS * 4));
                if (!activeRef.current) return;

                if (task.status === "completed") {
                    setConfirmQuestion("");
                    setSupplementDraft("");
                    const [videoBlob, frameDataUrl] = await Promise.all([
                        doubaoFetchTaskVideo(taskId, gatewaySignal(controller, DOWNLOAD_TIMEOUT_MS)),
                        doubaoFetchTaskLastFrame(taskId, gatewaySignal(controller, DOWNLOAD_TIMEOUT_MS)).then((blob) => URL.createObjectURL(blob)).catch(() => ""),
                    ]);
                    // 下载期间用户可能已取消：迟到的结果不允许覆盖 cancelled。
                    if (!activeRef.current) return;
                    if (frameDataUrl) setPreviewObjectUrl(frameDataUrl);
                    patchState({
                        status: "success",
                        statusText: "生成完成",
                        progress: 100,
                        latestReply: undefined,
                        lastRunAt: new Date().toISOString(),
                    });
                    if (addDoubaoResultNode) {
                        await addDoubaoResultNode(node, "video", videoBlob, `${node.title || "豆包视频"}.mp4`, { prompt: promptDraft.trim() });
                    }
                    message.success("豆包视频生成完成");
                    return;
                }

                if (task.status === "failed" || task.status === "cancelled") {
                    setConfirmQuestion("");
                    patchState({
                        status: task.status === "cancelled" ? "cancelled" : "error",
                        error: task.error || task.status_text || "视频生成失败",
                    });
                    return;
                }

                if (task.status === "needs_attention") {
                    patchState({
                        status: "needs_attention",
                        statusText: task.status_text || "需要在豆包工作站完成人机验证",
                    });
                    return;
                }

                const isWait = task.status === "awaiting_confirmation" || task.status === "awaiting_reply";
                const replyText = task.latest_reply || "";
                if (isWait) {
                    if (replyText) {
                        setConfirmQuestion(replyText);
                    }
                    // 等用户回复的时间不计入生成总超时：豆包问一句、用户可能想很久。
                    startedAt = Date.now();
                    patchState({
                        status: "running",
                        statusText: task.status_text || "豆包等待你的回复，请输入后点击“发送补充消息”",
                        progress: task.progress,
                        ...(replyText ? { latestReply: replyText } : {}),
                    });
                    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
                    continue;
                }

                patchState({
                    status: "running",
                    statusText: task.status_text || "生成中",
                    progress: task.progress,
                    ...(replyText ? { latestReply: replyText } : {}),
                });
                await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
            }
        } catch (cause) {
            // 取消/卸载/超时导致的 abort：状态已由取消方写入，这里不再覆盖。
            if (!activeRef.current) return;
            patchState({ status: "error", error: cause instanceof Error ? cause.message : String(cause) });
        } finally {
            activeRef.current = false;
        }
    }, [addDoubaoResultNode, message, node, patchState, promptDraft, setPreviewObjectUrl]);

    // 恢复未完成的视频任务轮询（刷新/重开画布后）；chat/image 的 running 状态没有可恢复的
    // 任务句柄，刷新后只会永久 busy，这里直接降级为可重试的 error。
    useEffect(() => {
        if (state.status !== "running") return;
        if (state.videoTaskId && !activeRef.current) {
            void pollVideo(state.videoTaskId);
        } else if (!state.videoTaskId) {
            patchState({ status: "error", error: "任务在上次会话中断，请重新运行" });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const run = useCallback(async () => {
        // 防重入：视频模式在收集参考素材阶段按钮还未切换为“取消”，
        // 双击会提交两个任务，这里用同步 ref 挡住。
        if (activeRef.current) return;
        const prompt = composePrompt();
        if (!prompt) {
            message.warning("请先输入提示词，或连接上游文本节点");
            return;
        }
        if (!state.accountId) {
            message.warning("请先选择豆包账号");
            return;
        }
        if (state.mode !== "chat" && accounts.length > 0 && !account) {
            message.warning("所选豆包账号已不存在，请重新选择账号");
            return;
        }
        activeRef.current = true;
        const controller = new AbortController();
        abortRef.current = controller;
        try {
            if (state.mode === "chat") {
                patchState({ status: "running", statusText: "思考中", prompt: promptDraft, resultText: undefined, error: undefined, lastRunAt: new Date().toISOString() });
                const content = await doubaoChatCompletion(state.accountId, prompt, false, gatewaySignal(controller, CHAT_TIMEOUT_MS));
                if (!activeRef.current) return;
                patchState({ status: "success", statusText: "", resultText: content });
                return;
            }
            if (state.mode === "image") {
                const references = await collectReferenceDataUrls();
                if (!activeRef.current) return;
                patchState({ status: "running", statusText: "生图中", prompt: promptDraft, error: undefined, lastRunAt: new Date().toISOString() });
                const { blob } = await doubaoGenerateImage(state.accountId, prompt, {
                    ratio: state.ratio || "1:1",
                    referenceDataUrls: references,
                    signal: gatewaySignal(controller, IMAGE_TIMEOUT_MS),
                });
                if (!activeRef.current) return;
                setPreviewObjectUrl(URL.createObjectURL(blob));
                patchState({ status: "success", statusText: "" });
                if (addDoubaoResultNode) {
                    await addDoubaoResultNode(node, "image", blob, `${node.title || "豆包图片"}.png`, { prompt: promptDraft.trim() });
                }
                message.success("豆包图片生成完成");
                return;
            }
            // video
            const references = await collectReferenceDataUrls();
            if (!activeRef.current) return;
            setConfirmQuestion("");
            setSupplementDraft("");
            patchState({ status: "running", statusText: "提交任务", prompt: promptDraft, error: undefined, latestReply: undefined, progress: 10, lastRunAt: new Date().toISOString() });
            // 默认值显式随请求发送：保证 UI 显示的参数与豆包页面实际使用的一致，
            // 不依赖账号页面上次的残留选择。
            const taskId = await doubaoSubmitVideoTask(state.accountId, prompt, {
                ratio: state.ratio || "16:9",
                duration: state.duration || 5,
                videoModel: state.videoModel || DEFAULT_VIDEO_MODEL,
                referenceDataUrls: references,
            });
            if (!activeRef.current) return;
            patchState({ videoTaskId: taskId });
            await pollVideo(taskId);
        } catch (cause) {
            if (!activeRef.current) return;
            patchState({ status: "error", error: cause instanceof Error ? cause.message : String(cause) });
        } finally {
            activeRef.current = false;
        }
    }, [account, accounts.length, addDoubaoResultNode, collectReferenceDataUrls, composePrompt, message, node, patchState, pollVideo, promptDraft, setPreviewObjectUrl, state.accountId, state.duration, state.mode, state.ratio, state.videoModel]);

    const cancel = useCallback(async () => {
        activeRef.current = false;
        abortRef.current?.abort();
        if (state.videoTaskId) {
            try {
                await doubaoCancelVideoTask(state.videoTaskId);
            } catch {
                // 取消失败不阻塞本地状态复位
            }
        }
        setConfirmQuestion("");
        setSupplementDraft("");
        patchState({ status: "cancelled", statusText: "已取消", videoTaskId: undefined });
    }, [patchState, state.videoTaskId]);

    // 豆包等待确认/补充材料时，把输入内容作为补充消息转交回豆包页面。
    const sendSupplement = useCallback(async (customText?: string) => {
        const text = (typeof customText === "string" ? customText : (supplementDraft || promptDraft)).trim();
        if (!text) {
            message.warning("请先输入要回复给豆包的内容");
            return;
        }
        if (!state.videoTaskId || sendingSupplement) return;
        setSendingSupplement(true);
        try {
            await doubaoConfirmVideoTask(state.videoTaskId, text);
            setSupplementDraft("");
            patchState({ statusText: "补充消息已转交，等待豆包继续生成" });
            message.success("补充消息已发送给豆包");
        } catch (cause) {
            message.error(cause instanceof Error ? cause.message : "补充消息发送失败");
        } finally {
            setSendingSupplement(false);
        }
    }, [message, patchState, promptDraft, sendingSupplement, state.videoTaskId, supplementDraft]);

    const addAccount = useCallback(async () => {
        try {
            await requestAddDoubaoAccount();
            message.success("已唤起豆包工作站扫码窗口，请用手机豆包 App 扫码登录");
            void refresh();
        } catch (cause) {
            message.error(cause instanceof Error ? cause.message : "添加账号失败");
        }
    }, [message, refresh]);

    // normalizeNodeState 已兜底未知 mode，这里再防一次直接索引越界。
    const modeIcon = (MODE_META[state.mode] || MODE_META.chat).icon;
    const runLabel = state.mode === "chat" ? "发送" : state.mode === "image" ? "生成图片" : "生成视频";
    const ModeIcon = modeIcon;

    return (
        <div className="flex h-full w-full flex-col gap-2 overflow-y-auto p-3 pt-8 pb-4 text-xs scrollbar-thin" style={{ color: theme.node.text }}>
            {/* 账号选择 */}
            <div className="flex items-center gap-1.5">
                <Select
                    size="small"
                    virtual={false}
                    style={{ minWidth: 0, flex: 1 }}
                    placeholder="选择豆包账号"
                    value={state.accountId}
                    loading={loading}
                    onChange={(value) => {
                        setConfirmQuestion("");
                        setSupplementDraft("");
                        patchState({
                            accountId: value,
                            status: state.status === "running" ? state.status : "idle",
                            statusText: state.status === "running" ? state.statusText : "",
                            error: undefined,
                            latestReply: undefined,
                            videoTaskId: state.status === "running" ? state.videoTaskId : undefined,
                        });
                    }}
                    options={accounts.map((item) => ({
                        value: item.id,
                        label: (
                            <span className="flex items-center gap-1.5">
                                <span className="inline-block size-1.5 rounded-full" style={{ background: doubaoAccountStatusMeta(item.status).color }} />
                                {item.name}
                            </span>
                        ),
                    }))}
                    notFoundContent={
                        <button type="button" className="flex w-full items-center gap-1 px-1 py-0.5 text-left" onClick={() => void addAccount()}>
                            <Plus className="size-3" />
                            {gatewayOffline ? "网关离线：请启动豆包工作站" : "添加豆包账号（扫码）"}
                        </button>
                    }
                    suffixIcon={accountMeta ? <span className="inline-block size-1.5 rounded-full" style={{ background: accountMeta.color }} /> : undefined}
                />
                <button type="button" title="刷新账号列表" className="flex size-6 shrink-0 items-center justify-center rounded hover:bg-black/5" onClick={() => void refresh()}>
                    <RefreshCw className={`size-3 ${loading || refreshing ? "animate-spin" : ""}`} />
                </button>
                <button type="button" title="添加豆包账号" className="flex size-6 shrink-0 items-center justify-center rounded hover:bg-black/5" onClick={() => void addAccount()}>
                    <Plus className="size-3.5" />
                </button>
            </div>

            {/* 豆包回复展示：醒目卡片，让用户清晰看到豆包回复了什么 */}
            {(Boolean(displayReply) || isWaitingReply) && (
                <div
                    className="flex flex-col gap-1.5 rounded-lg border p-2.5 text-xs shadow-sm"
                    style={{
                        borderColor: isWaitingReply ? "rgba(16, 185, 129, 0.45)" : "rgba(255, 255, 255, 0.15)",
                        background: isWaitingReply ? "rgba(16, 185, 129, 0.12)" : "rgba(0, 0, 0, 0.25)",
                    }}
                >
                    <div className="flex items-center justify-between text-[11px] font-medium" style={{ color: isWaitingReply ? "#10b981" : "#9ca3af" }}>
                        <span className="flex items-center gap-1.5">
                            <MessageSquareText className="size-3.5" />
                            <b>豆包回复：</b>
                        </span>
                        {isWaitingReply && (
                            <span className="rounded bg-emerald-500/25 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-400 border border-emerald-500/30">
                                等待回复
                            </span>
                        )}
                    </div>
                    <div
                        className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words leading-relaxed text-[12px] scrollbar-thin pr-1"
                        style={{ color: isWaitingReply ? "#ecfdf5" : theme.node.text }}
                    >
                        {displayReply || "豆包等待你的回复，请在下方发送补充消息"}
                    </div>
                </div>
            )}

            {/* 等待回复时的快捷回复输入栏 */}
            {isWaitingReply && (
                <div className="flex items-center gap-1.5">
                    <input
                        type="text"
                        className="flex-1 rounded border px-2.5 py-1.5 text-xs outline-none"
                        style={{ background: theme.node.panel, color: theme.node.text, borderColor: "rgba(16, 185, 129, 0.45)" }}
                        placeholder="回复豆包（确认或补充要求，按回车发送）…"
                        value={supplementDraft}
                        onChange={(e) => setSupplementDraft(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.shiftKey) {
                                e.preventDefault();
                                void sendSupplement(supplementDraft);
                            }
                        }}
                    />
                    <button
                        type="button"
                        disabled={sendingSupplement || (!supplementDraft.trim() && !promptDraft.trim())}
                        className="flex items-center justify-center gap-1 rounded px-3 py-1.5 font-medium disabled:opacity-50 text-white shadow-sm"
                        style={{ background: "#00b96b" }}
                        onClick={() => void sendSupplement(supplementDraft || promptDraft)}
                    >
                        {sendingSupplement ? <LoaderCircle className="size-3 animate-spin" /> : <Send className="size-3" />}
                        发送
                    </button>
                </div>
            )}

            {/* 提示词区域：生成中显示紧凑原始提示词摘要；空闲时显示完整文本框 */}
            {busy ? (
                <div className="rounded border px-2.5 py-1.5 text-[11px] leading-relaxed truncate" style={{ background: theme.node.panel, borderColor: theme.node.stroke }}>
                    <span className="opacity-60">原始提示词：</span>
                    <span className="font-medium">{promptDraft || "（无提示词）"}</span>
                </div>
            ) : (
                <textarea
                    className="w-full min-h-[56px] resize-none rounded border p-2 text-xs outline-none"
                    style={{ background: theme.node.panel, color: theme.node.text, borderColor: theme.node.stroke }}
                    placeholder={state.mode === "chat" ? "输入问题，如：帮我扩写这段分镜脚本…" : "输入生成提示词…"}
                    value={promptDraft}
                    rows={2}
                    onChange={(event) => setPromptDraft(event.target.value)}
                />
            )}

            {/* 参数区域：生成中显示紧凑参数标签；空闲时显示下拉框与滑块 */}
            {busy ? (
                state.mode !== "chat" && (
                    <div className="flex items-center gap-1.5 text-[11px] opacity-75">
                        <span className="rounded bg-black/20 border border-white/10 px-2 py-0.5">{state.ratio || (state.mode === "image" ? "1:1" : "16:9")}</span>
                        {state.mode === "video" && (
                            <>
                                <span className="rounded bg-black/20 border border-white/10 px-2 py-0.5">{state.videoModel || DEFAULT_VIDEO_MODEL}</span>
                                <span className="rounded bg-black/20 border border-white/10 px-2 py-0.5">{state.duration || 5} 秒</span>
                            </>
                        )}
                    </div>
                )
            ) : (
                <>
                    {state.mode !== "chat" && (
                        <div className="flex items-center gap-1.5">
                            <Select
                                size="small"
                                virtual={false}
                                style={{ width: 84 }}
                                value={state.ratio || (state.mode === "image" ? "1:1" : "16:9")}
                                onChange={(ratio) => patchState({ ratio })}
                                options={(state.mode === "image" ? IMAGE_RATIOS : VIDEO_RATIOS).map((ratio) => ({ value: ratio, label: ratio }))}
                            />
                            {state.mode === "video" && (
                                <Select
                                    size="small"
                                    virtual={false}
                                    style={{ flex: 1, minWidth: 0 }}
                                    value={state.videoModel || DEFAULT_VIDEO_MODEL}
                                    onChange={(videoModel) => patchState({ videoModel })}
                                    options={VIDEO_MODELS.map((model) => ({ value: model, label: model }))}
                                />
                            )}
                        </div>
                    )}
                    {state.mode === "video" && (
                        <div className="flex items-center gap-2">
                            <Slider
                                className="flex-1"
                                min={MIN_DURATION}
                                max={MAX_DURATION}
                                step={1}
                                value={state.duration || 5}
                                marks={{ 4: "4s", 10: "10s", 20: "20s", 30: "30s" }}
                                onChange={(value) => patchState({ duration: value })}
                                tooltip={{ formatter: (value) => `${value} 秒` }}
                            />
                            <span className="shrink-0 text-xs opacity-70">{state.duration || 5} 秒</span>
                        </div>
                    )}
                </>
            )}

            {/* 状态与进度条 */}
            {busy && (
                <div className="flex flex-col gap-1 pt-0.5">
                    <span className="flex items-center gap-1.5 text-[11px] opacity-80">
                        <LoaderCircle className="size-3 animate-spin shrink-0 text-emerald-400" />
                        <span className="truncate">{state.statusText || (isWaitingReply ? "等待你的回复中…" : "处理中…")}</span>
                    </span>
                    {state.mode === "video" && <Progress percent={state.progress ?? (isWaitingReply ? 30 : 15)} size="small" showInfo={false} strokeColor="#00b96b" />}
                </div>
            )}

            {/* 执行 / 取消按钮 */}
            <div className="flex items-center gap-1.5 pt-1">
                {busy ? (
                    <button
                        type="button"
                        className="flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1.5 font-medium text-white shadow-sm transition-opacity hover:opacity-90"
                        style={{ background: "#ff4d4f" }}
                        onClick={() => void cancel()}
                    >
                        <Square className="size-3" />
                        取消任务
                    </button>
                ) : (
                    <button
                        type="button"
                        className="flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1.5 font-medium text-white shadow-sm transition-opacity hover:opacity-90"
                        style={{ background: "#00b96b" }}
                        onClick={() => void run()}
                    >
                        <Play className="size-3" />
                        {runLabel}
                    </button>
                )}
            </div>

            {/* 其他辅助状态与结果 */}
            {state.status === "needs_attention" && (
                <span className="flex items-center gap-1" style={{ color: "#fa8c16" }}><CircleAlert className="size-3 shrink-0" />{state.statusText || "需要人工介入"}</span>
            )}
            {state.status === "error" && (
                <span className="flex items-start gap-1 break-all" style={{ color: "#ff4d4f" }}><CircleAlert className="mt-0.5 size-3 shrink-0" />{state.error || "执行失败"}</span>
            )}
            {previewUrl && state.mode !== "chat" && <img src={previewUrl} alt="豆包生成结果预览" className="max-h-28 w-full rounded object-contain" style={{ background: theme.node.panel }} />}
            {state.mode === "chat" && state.resultText && (
                <div className="max-h-40 flex-1 overflow-auto whitespace-pre-wrap break-words rounded p-2" style={{ background: theme.node.panel }}>
                    {state.resultText}
                </div>
            )}
            {state.mode === "chat" && state.resultText && (
                <span className="flex items-center gap-1 opacity-60"><ModeIcon className="size-3" /> 对话结果可作为文本素材连线给下游节点</span>
            )}
            {gatewayOffline && !busy && (
                <span className="flex items-center gap-1" style={{ color: "#faad14" }}><CircleAlert className="size-3 shrink-0" />豆包工作站网关未连接，生成功能暂不可用</span>
            )}
            {!gatewayOffline && error && !busy && (
                <span className="flex items-center gap-1 opacity-60"><CircleAlert className="size-3 shrink-0" />{error}</span>
            )}
        </div>
    );
}
