import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";

import { CanvasAssistantSidebar } from "@/pages/canvas/canvas-assistant-sidebar";
import type { CanvasAssistantController } from "@/pages/canvas/use-canvas-assistant";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import type { AgentHostStatus, AssistantTurn } from "@/services/api/agent-assistant";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasNodeType } from "@/types/canvas";

/**
 * DEV 实验室：只为验收助手停靠栏的视觉与状态分支。
 *
 * 不连后端、不调模型：所有数据都是本页写死的样例，用查询参数切换场景
 * （?state=ready|unavailable|starting&narrow=1&dark=1）。生产构建不含此路由。
 */
const REFERENCES: CanvasResourceReference[] = [
    { id: "n1", nodeId: "n1", kind: "text", label: "镜头1", title: "镜头1-开场", active: true, sourceType: CanvasNodeType.Text, mentionToken: "@[node:n1]" },
    { id: "n2", nodeId: "n2", kind: "image", label: "镜头2", title: "镜头2-冲突", active: true, sourceType: CanvasNodeType.Image, mentionToken: "@[node:n2]" },
];

const TURNS: AssistantTurn[] = [
    {
        turnId: "turn-1",
        userText: "把剧本拆成三个镜头，并按顺序连起来",
        selectedNodeIds: ["n1", "n2"],
        reply: "已经按开场、冲突、收尾拆成三个镜头，并按这个顺序连好。\n\n- **镜头1 开场**：雨夜巷口，远景压住情绪\n- **镜头2 冲突**：近景对峙，光只打半张脸\n- **镜头3 收尾**：中景离场，留一句没说完的台词",
        toolCalls: [
            { toolCallId: "t1", tool: "canvas.nodes.create" },
            { toolCallId: "t2", tool: "canvas.edge.create" },
            { toolCallId: "t3", tool: "canvas.node.update", isError: true, error: "conflict" },
        ],
        change: { revisionBefore: 12, revisionAfter: 13, createdNodeIds: ["n3", "n4", "n5"], updatedNodeIds: [], createdEdgeIds: ["e1", "e2"] },
        proposals: [{ proposalId: "p1", kind: "image", nodeIds: ["n3", "n4", "n5"], model: "seedream-4", modelKey: "beefapi::seedream-4" }],
        error: null,
        cancelled: false,
        createdAt: new Date("2026-09-29T10:00:00Z").toISOString(),
    },
];

function stubController(open: boolean, setOpen: (next: boolean) => void, width: number, setWidth: (next: number) => void, status: AgentHostStatus | null): CanvasAssistantController {
    const noop = () => {};
    const asyncNoop = async () => {};
    return {
        plan: null,
        canvasId: "lab",
        open,
        setOpen,
        width,
        setWidth,
        status,
        statusBusy: false,
        modelBusy: false,
        sessions: [
            { sessionId: "s1", title: "把剧本拆成三个镜头，并按顺序连起来", updatedAt: new Date().toISOString(), turnCount: 1 },
            { sessionId: "s2", title: "检查哪些镜头还缺参考图", updatedAt: new Date().toISOString(), turnCount: 3 },
        ],
        sessionId: "s1",
        turns: status?.available ? TURNS : [],
        historyLoaded: true,
        historyError: null,
        sessionBusy: false,
        reloadHistory: async () => true,
        pendingUserText: null,
        pendingContinuationId: null,
        pendingSelectedNodeIds: [],
        pendingAttachments: [],
        pendingSkills: [],
        permissionMode: "canvas",
        permissionLocked: false,
        setPermissionMode: noop,
        streamed: "",
        streaming: false,
        awaitingReceipt: false,
        supplements: [],
        supplementBusy: false,
        canSupplement: false,
		lifecycleNotice: null,
        error: null,
        canRetry: false,
        turnStatus: {},
        handledProposals: new Set<string>(),
        markProposalHandled: noop,
        markProposalDismissed: noop,
        send: asyncNoop,
        stop: asyncNoop,
        retryLast: noop,
        dismissError: noop,
        startNewSession: asyncNoop,
        activateSession: asyncNoop,
        undoTurn: asyncNoop,
        restartHost: asyncNoop,
    };
}

export default function AssistantPanelLab() {
    const [params] = useSearchParams();
    const state = params.get("state") || "ready";
    const narrow = params.get("narrow") === "1";
    const dark = params.get("dark") === "1";
    const [open, setOpen] = useState(true);
    const [width, setWidth] = useState(380);

    // CSS 变量和 antd 主题必须同时切：只切一边会让按钮文字和底色撞在一起。
    useEffect(() => {
        document.documentElement.classList.toggle("dark", dark);
        useThemeStore.getState().setTheme(dark ? "dark" : "light");
    }, [dark]);

    const status: AgentHostStatus | null =
        state === "unavailable"
            ? { available: false, reason: "credential_missing" }
            : state === "starting"
              ? { available: false, reason: "host_starting" }
              : state === "no-model"
                ? { available: false, reason: "model_not_configured" }
                : { available: true, model: { id: "deepseek-v3", channelId: "beefapi", channelName: "BeefAPI" } };

    const assistant = stubController(open, setOpen, width, setWidth, status);
    if (state === "interrupted") {
        assistant.turns = [{ ...TURNS[0], proposals: [], error: "本轮达到等待上限", errorReason: "turn_timeout", change: { ...TURNS[0].change!, timelineUpdated: true } }];
    }
    if (state === "streaming") {
        assistant.streaming = true;
        assistant.canSupplement = true;
        assistant.pendingUserText = "检查参考视频的声音，去掉中间黑屏，保留咖啡和蛋糕的结尾";
        assistant.streamed = "已找到中间的黑屏，正在检查这段声音。";
        assistant.supplements = [{ text: "不要删除片尾的两秒停顿", status: "accepted" }];
        assistant.lifecycleNotice = "正在检查媒体";
    }

    return (
        <div className="flex h-screen min-h-0" style={{ background: "var(--background)", color: "var(--foreground)" }}>
            <div className="flex min-w-0 flex-1 items-center justify-center" style={{ background: "var(--muted)" }}>
                <p className="text-sm" style={{ color: "var(--muted-foreground)" }}>画布区域（实验室占位）</p>
            </div>
            <CanvasAssistantSidebar
                assistant={assistant}
                canvasTitle="雨夜巷口"
                dockable={!narrow}
                readOnly={params.get("readonly") === "1"}
                selectedNodeIds={["n1", "n2"]}
                references={REFERENCES}
                onLocateNodes={() => {}}
                onRunProposal={() => {}}
                onOpenModelSettings={() => {}}
            />
        </div>
    );
}
