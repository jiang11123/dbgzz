import { formatBytes } from "@/lib/image-utils";

export type OperationPhase = "preparing" | "transferring" | "processing" | "done" | "error";
export type CanvasOperationTarget = { projectId: string; nodeId: string; taskId?: string };
export type OperationProgress = {
    id: string;
    title: string;
    detail: string;
    phase: OperationPhase;
    loadedBytes?: number;
    totalBytes?: number;
    bytesPerSecond?: number;
    completedFiles?: number;
    totalFiles?: number;
    startedAt: number;
    updatedAt: number;
    target?: CanvasOperationTarget;
};

export function canvasNodeOperation(entries: Record<string, OperationProgress>, projectId: string | undefined, nodeId: string, taskId?: string) {
    return Object.values(entries).reverse().find(item => {
        if (!item.target || item.phase === "done" || item.phase === "error") return false;
        if (item.target.projectId !== projectId) return false;
        return item.target.taskId ? item.target.taskId === taskId && item.target.nodeId === nodeId : item.target.projectId === projectId && item.target.nodeId === nodeId;
    });
}

const finite = (value: number | undefined) => value !== undefined && Number.isFinite(value) && value >= 0;
export const progressBytes = (value: number) => formatBytes(Math.max(0, value)) || "0 B";

export function progressDuration(seconds: number) {
    const value = Math.max(0, Math.ceil(seconds));
    if (value < 60) return value + " 秒";
    const minutes = Math.floor(value / 60);
    return minutes < 60 ? minutes + " 分 " + value % 60 + " 秒" : Math.floor(minutes / 60) + " 小时 " + minutes % 60 + " 分";
}

export function operationProgressView(progress: OperationProgress, now = Date.now()) {
    const transferring = progress.phase === "transferring";
    const loaded = finite(progress.loadedBytes) ? progress.loadedBytes! : undefined;
    const known = finite(progress.totalBytes) && progress.totalBytes! > 0;
    const fresh = now - progress.updatedAt < 3000;
    const speed = transferring && fresh && finite(progress.bytesPerSecond) ? progress.bytesPerSecond! : 0;
    const size = loaded === undefined ? known ? "文件大小 " + progressBytes(progress.totalBytes!) : "" : progressBytes(loaded) + (known ? " / " + progressBytes(progress.totalBytes!) : "");
    const remaining = known && loaded !== undefined && loaded < progress.totalBytes! && speed > 0 && now - progress.startedAt >= 1500
        ? "预计剩余 " + progressDuration((progress.totalBytes! - loaded) / speed) : "";
    const count = finite(progress.totalFiles) && progress.totalFiles! > 0
        ? Math.min(progress.completedFiles || 0, progress.totalFiles!) + " / " + progress.totalFiles + " 个文件" : "";
    return {
        percent: progress.phase === "done" ? 100 : transferring && known && loaded !== undefined ? Math.min(100, Math.floor(loaded / progress.totalBytes! * 100)) : null,
        size,
        speed: speed > 0 ? progressBytes(speed) + "/s" : "",
        timing: remaining || (progress.phase !== "done" && progress.phase !== "error" ? "已用 " + progressDuration((now - progress.startedAt) / 1000) : ""),
        count,
    };
}

/** A restarted request resets the rate; idle time must never look like a live speed. */
export function createTransferSampler(now = Date.now()) {
    let previous = { loaded: 0, at: now };
    let lastMovement = now;
    let lastLoaded = 0;
    let speed = 0;
    return (loaded: number, total?: number, at = Date.now()) => {
        loaded = finite(loaded) ? loaded : 0;
        if (loaded !== lastLoaded) lastMovement = at;
        lastLoaded = loaded;
        if (loaded < previous.loaded) {
            speed = 0;
            previous = { loaded, at };
        } else if (at - previous.at >= 300) {
            const measured = (loaded - previous.loaded) * 1000 / (at - previous.at);
            speed = speed > 0 ? speed * 0.35 + measured * 0.65 : measured;
            previous = { loaded, at };
        }
        if (at - lastMovement >= 3000) speed = 0;
        return { loadedBytes: finite(total) && total! > 0 ? Math.min(loaded, total!) : loaded, totalBytes: finite(total) ? total : undefined, bytesPerSecond: speed, updatedAt: at };
    };
}
