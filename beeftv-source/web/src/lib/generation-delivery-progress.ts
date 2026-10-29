import { formatBytes } from "@/lib/image-utils";
import type { GenerationTaskDeliveryProgress } from "@/services/api/task-center";
import { progressDuration } from "@/lib/operation-progress";

export type GenerationDeliveryProgressView = { title: string; percent: number | null; detail: string; size: string; speed: string; timing: string };

function sizeLabel(bytes: number) {
    return formatBytes(bytes) || "0 B";
}

// Backend stage while a finished video result is being fetched (set by the
// generation download loop before any bytes arrive).
export const GENERATION_RESULT_FETCH_STAGE = "正在取回生成结果";

export function generationTaskFetchingResult(task: { status: string; stage?: string }, hasDelivery: boolean) {
    return hasDelivery || task.status === "succeeded" || (task.status === "running" && task.stage === GENERATION_RESULT_FETCH_STAGE);
}

export function generationDeliveryProgressView(progress: GenerationTaskDeliveryProgress, now = Date.now()): GenerationDeliveryProgressView {
    if (progress.state === "waiting") return { title: "正在取回结果", percent: null, detail: "等待结果就绪", size: "", speed: "", timing: "等待结果就绪" };
    const downloaded = Math.max(0, progress.downloadedBytes);
    const known = progress.totalBytes > 0;
    const percent = known ? Math.min(100, Math.floor((downloaded * 100) / progress.totalBytes)) : null;
    const size = known ? `${sizeLabel(downloaded)} / ${sizeLabel(progress.totalBytes)}` : sizeLabel(downloaded);
    const retrying = progress.state === "retrying";
    const speed = !retrying && progress.updatedAt && now - progress.updatedAt < 3000 ? progress.bytesPerSecond : 0;
    const speedLabel = speed > 0 ? `${sizeLabel(speed)}/s` : "";
    const timing = known && downloaded < progress.totalBytes && speed > 0 ? "预计剩余 " + progressDuration((progress.totalBytes - downloaded) / speed) : "";
    return {
        title: retrying ? "下载中断，正在重试" : "正在取回结果",
        percent,
        detail: [size, speedLabel, timing].filter(Boolean).join(" · "),
        size, speed: speedLabel, timing,
    };
}
