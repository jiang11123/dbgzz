import type { GenerationTask, TaskStatus } from "@/services/api/task-center";

export const statusLabel: Record<TaskStatus, string> = {
    queued: "排队中",
    running: "生成中",
    succeeded: "已完成",
    failed: "失败",
    cancelled: "已取消",
};

type GenerationTaskDisplayTarget = Pick<GenerationTask, "status" | "stage">;

export function isGenerationTaskSubmissionUncertain(task: GenerationTaskDisplayTarget) {
    return task.stage === "submission_unknown";
}

export function generationTaskStatusLabel(task: GenerationTaskDisplayTarget) {
    if (isGenerationTaskSubmissionUncertain(task)) return "提交结果待确认";
    if (task.stage === "delivery_paused" || task.stage === "delivery_timed_out") return "待取回结果";
    return statusLabel[task.status];
}

export function generationTaskStageLabel(task: GenerationTaskDisplayTarget) {
    if (isGenerationTaskSubmissionUncertain(task)) return "为避免重复创建上游任务，未自动重试";
    if (task.stage === "delivery_paused") return "已暂停取回结果";
    if (task.stage === "delivery_timed_out") return "下载超时，可继续取回原结果";
    if (task.stage === "generating") return "生成中";
    if (task.stage === "queued") return "排队中";
    return task.stage || generationTaskStatusLabel(task);
}

export function generationTaskShowsProgress(task: GenerationTaskDisplayTarget) {
    if (isGenerationTaskSubmissionUncertain(task) || task.stage === "delivery_paused" || task.stage === "delivery_timed_out") return false;
    // 排队、后端接管和连接供应商都没有真实百分比。只有上游状态响应
    // 已经写回任务后才显示进度，避免所有图片/视频长期停在同一个假数值。
    if (["等待队列调度", "后端接管任务", "正在连接上游", "调用生成模型"].includes(task.stage || "")) return false;
    return true;
}

/** 上游百分比多久没动，就不再把它画成一根停住的进度条。 */
export const GENERATION_PROGRESS_STALL_MS = 60_000;

export const GENERATION_VIDEO_EXPECTATION = "视频通常要几分钟，可以先做别的。";

export type GenerationProgressRecord = { progress: number; changedAt: number };

/**
 * 记录上游百分比最后一次变化的时间（只在客户端记，不改任务数据）。
 * 百分比没变就原样返回旧记录，变了或第一次看到就以 now 作为变化时间。
 */
export function trackGenerationProgressChange(previous: GenerationProgressRecord | undefined, progress: number, now: number): GenerationProgressRecord {
    if (previous && previous.progress === progress) return previous;
    return { progress, changedAt: now };
}

export type GenerationProgressDisplay = {
    /** none：不画进度条；determinate：按真实百分比画；indeterminate：百分比久未变化，改为循环扫描。 */
    bar: "none" | "determinate" | "indeterminate";
    /** 只在 determinate 时给出，永远是上游返回的真实值。 */
    percent: number | null;
    /** 视频任务进行中给出的一句预期说明。 */
    expectation: string | null;
};

export function generationProgressDisplay(input: {
    status: GenerationTask["status"];
    progress: number | null;
    progressChangedAt?: number;
    now: number;
    isVideo: boolean;
}): GenerationProgressDisplay {
    const active = input.status === "queued" || input.status === "running";
    const expectation = active && input.isVideo ? GENERATION_VIDEO_EXPECTATION : null;
    if (input.progress === null) return { bar: "none", percent: null, expectation };
    const stalled = input.status === "running"
        && input.progressChangedAt !== undefined
        && input.now - input.progressChangedAt >= GENERATION_PROGRESS_STALL_MS;
    if (stalled) return { bar: "indeterminate", percent: null, expectation };
    return { bar: "determinate", percent: input.progress, expectation };
}

/** 已用时间，例如「3分12秒」「1时05分」。 */
export function formatGenerationElapsed(elapsedMs: number) {
    const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
    if (seconds < 60) return `${seconds}秒`;
    const minutes = Math.floor(seconds / 60);
    return minutes < 60 ? `${minutes}分${seconds % 60}秒` : `${Math.floor(minutes / 60)}时${minutes % 60}分`;
}

export const operationOptions = [
    { label: "文生视频", value: "text_to_video" },
    { label: "图生视频", value: "image_to_video" },
    { label: "全模态参考", value: "reference_to_video" },
    { label: "视频续写", value: "extend" },
    { label: "视频局部修改", value: "inpaint" },
    { label: "元素替换", value: "replace_element" },
    { label: "镜头/运镜调整", value: "camera_motion" },
    { label: "风格迁移", value: "style_transfer" },
    { label: "参考音频生成视频", value: "audio_to_video" },
    { label: "结果版本对比", value: "compare_versions" },
];

export const operationLabelByValue = new Map(operationOptions.map((item) => [item.value, item.label]));

export const taskTypeLabel: Record<string, string> = {
    canvas_image: "画布生图",
    canvas_video: "画布视频",
    canvas_audio: "画布音频",
    canvas_text: "画布文本",
};

export function formatTaskKind(task: GenerationTask) {
    const typeLabel = taskTypeLabel[task.type];
    const operationLabel = task.operation ? operationLabelByValue.get(task.operation) : "";

    if (task.type === "canvas_video" && operationLabel) return `${typeLabel || "画布视频"} · ${operationLabel}`;
    if (typeLabel) return typeLabel;
    if (operationLabel) return operationLabel;
    if (task.type.startsWith("video_")) return "视频任务";
    return "生成任务";
}
