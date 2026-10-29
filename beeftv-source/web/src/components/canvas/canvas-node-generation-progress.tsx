import { useEffect, useState } from "react";
import { AlertCircle, Clock3, FileText, Square } from "lucide-react";
import type { CanvasTheme } from "@/lib/canvas-theme";
import { generationDeliveryProgressView, generationTaskFetchingResult } from "@/lib/generation-delivery-progress";
import { formatGenerationElapsed, generationProgressDisplay, generationTaskShowsProgress, isGenerationTaskSubmissionUncertain, trackGenerationProgressChange, type GenerationProgressRecord } from "@/lib/generation-task-display";
import { operationProgressView, type OperationProgress } from "@/lib/operation-progress";
import type { GenerationTask } from "@/services/api/task-center";
import { subscribeUserScope } from "@/lib/user-scope";
import { useGenerationDeliveryProgress } from "@/stores/use-generation-delivery-progress";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { DoubaoTaskReply } from "@/components/canvas/doubao-task-reply";

type Props = {
    node: CanvasNodeData;
    theme: CanvasTheme;
    operation?: OperationProgress;
    onOpenTaskDetails?: (node: CanvasNodeData) => void;
    onCancelTask?: (node: CanvasNodeData) => void;
};

export function CanvasNodeGenerationProgress({ node, theme, operation, onOpenTaskDetails, onCancelTask }: Props) {
    const taskId = node.metadata?.taskId;
    // Before task creation, old task controls must not act on a previous result.
    const hasTaskIdentity = operation ? Boolean(operation.target?.taskId) : Boolean(taskId) || node.metadata?.fixture === "libtv-generating";
    const displayTask = { status: (node.metadata?.taskStatus || "running") as GenerationTask["status"], stage: node.metadata?.taskStage };
    const now = useSecondTick(hasTaskIdentity || Boolean(operation));
    const createdAt = operation?.startedAt ?? new Date(node.metadata?.taskCreatedAt || "").getTime();
    const elapsed = Number.isFinite(createdAt) ? `已用 ${formatGenerationElapsed(now - createdAt)}` : "刚刚开始";
    const progress = generationTaskShowsProgress(displayTask) && taskId && typeof node.metadata?.taskProgress === "number" ? Math.max(0, Math.min(100, Math.round(node.metadata.taskProgress))) : null;
    const record = progress !== null ? rememberProgressChange(taskId || node.id, progress, now) : undefined;
    const generation = generationProgressDisplay({ status: displayTask.status, progress, progressChangedAt: record?.changedAt, now, isVideo: node.type === CanvasNodeType.Video });
    const deliveryProgress = useGenerationDeliveryProgress(state => taskId ? state.byTask[taskId] : undefined);
    const delivery = deliveryProgress ? generationDeliveryProgressView(deliveryProgress, now) : undefined;
    const fetching = generationTaskFetchingResult(displayTask, Boolean(deliveryProgress));
    const pendingStage = ["正在准备生成任务", "正在准备参考素材", "正在提交生成任务"].includes(displayTask.stage || "") ? displayTask.stage : undefined;
    const queued = displayTask.status === "queued";
    const fileMetrics = operation ? operationProgressView(operation, now) : undefined;
    const metrics = fileMetrics || delivery;
    const title = operation?.detail || delivery?.title || (fetching ? "正在取回结果" : queued ? "排队中" : pendingStage || "生成中");
    const percent = metrics ? metrics.percent : fetching || queued || pendingStage ? null : generation.percent;
    const bar = metrics || fetching || queued || pendingStage ? percent === null ? "indeterminate" : "determinate" : generation.bar;
    const timing = metrics?.timing || (!fetching ? elapsed : "");
    const uncertain = !operation && Boolean(taskId) && isGenerationTaskSubmissionUncertain(displayTask);
    const controls = hasTaskIdentity && (!operation || displayTask.status !== "succeeded");

    return <div role="status" aria-label={title} className="flex h-full w-full flex-col items-center justify-center gap-3 px-5 text-center" style={{ background: theme.node.fill, color: theme.node.activeStroke }}>
        {uncertain ? <AlertCircle className="size-10" /> : <div className="size-10 animate-spin rounded-full border-2 motion-reduce:animate-none" style={{ borderColor: theme.node.stroke, borderTopColor: theme.node.activeStroke }} />}
        <span className="max-w-full text-xs font-semibold leading-5 break-words">{title}</span>
        {hasTaskIdentity || operation ? <div className="flex w-full max-w-[260px] flex-col items-center gap-2">
            {percent !== null ? <span className="text-[var(--fs-label)] font-medium tabular-nums" style={{ color: theme.node.text }}>{percent}%</span> : null}
            {bar !== "none" ? <div role="progressbar" aria-label={title} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined} className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: theme.node.stroke }}>
                <div className={bar === "indeterminate" ? "canvas-node-progress-indeterminate h-full rounded-full" : "h-full rounded-full transition-[width]"} style={{ width: percent === null ? undefined : `${percent}%`, background: theme.node.activeStroke }} />
            </div> : null}
            {metrics?.size ? <span className="whitespace-nowrap text-xs tabular-nums" style={{ color: theme.node.text }}>{metrics.size}</span> : null}
            {metrics?.speed || fileMetrics?.count ? <div className="flex max-w-full flex-wrap justify-center gap-x-3 gap-y-1 text-[var(--fs-tiny)] tabular-nums" style={{ color: theme.node.muted }}>
                {metrics?.speed ? <span className="whitespace-nowrap">{metrics.speed}</span> : null}
                {fileMetrics?.count ? <span className="whitespace-nowrap">{fileMetrics.count}</span> : null}
            </div> : null}
            {timing ? <span className="whitespace-nowrap text-[var(--fs-tiny)] tabular-nums" style={{ color: theme.node.muted }}>{timing.startsWith("已用") ? <Clock3 className="mr-1 inline size-3 align-[-2px]" /> : null}{timing}</span> : null}
            {controls ? <div className="mt-0.5 flex items-center gap-1.5">
                <button type="button" className="inline-flex h-7 items-center gap-1 rounded-[var(--r-sm)] px-2 text-[var(--fs-tiny)] font-medium" style={{ background: theme.toolbar.itemHover, color: theme.node.text }} onMouseDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onOpenTaskDetails?.(node); }}><FileText className="size-3" />详情</button>
                {onCancelTask && ["queued", "running", "succeeded"].includes(displayTask.status) ? <button type="button" className="inline-flex h-7 items-center gap-1 rounded-[var(--r-sm)] px-2 text-[var(--fs-tiny)] font-medium" style={{ background: theme.toolbar.itemHover, color: theme.node.muted }} onMouseDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onCancelTask(node); }} aria-label={displayTask.status === "succeeded" ? "停止取回结果" : "取消生成任务"}><Square className="size-3" />{displayTask.status === "succeeded" ? "停止取回" : "取消"}</button> : null}
            </div> : null}
        </div> : null}
        <DoubaoTaskReply node={node} theme={theme} />
    </div>;
}

function useSecondTick(active: boolean) {
    const [, setTick] = useState(0);
    useEffect(() => {
        if (!active) return;
        const timer = window.setInterval(() => setTick(value => value + 1), 1000);
        return () => window.clearInterval(timer);
    }, [active]);
    return Date.now();
}

const progressChangeByTask = new Map<string, GenerationProgressRecord>();
subscribeUserScope(() => progressChangeByTask.clear());
function rememberProgressChange(key: string, progress: number, now: number) {
    const previous = progressChangeByTask.get(key);
    const next = trackGenerationProgressChange(previous, progress, now);
    if (next !== previous) {
        progressChangeByTask.delete(key);
        progressChangeByTask.set(key, next);
        if (progressChangeByTask.size > 200) {
            const oldest = progressChangeByTask.keys().next().value;
            if (oldest !== undefined) progressChangeByTask.delete(oldest);
        }
    }
    return next;
}
