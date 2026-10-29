import { generationTaskMode } from "@/lib/canvas/canvas-generation-task-sync";
import { userScopeEpochMatches, type UserScopeEpoch } from "@/lib/user-scope";
import type { GenerationTask } from "@/services/api/task-center";

const INSERTABLE_HISTORY_MODES = new Set(["image", "video", "audio"]);

export type CanvasGenerationHistorySelectGate = {
    open: boolean;
    projectId: string;
    epoch: UserScopeEpoch;
    mounted: boolean;
    selectionEpoch: number;
};

/** List filter for TaskSummary cards. Display uses previewUrl/previewKind; resultJson lives on detail. */
export function insertableCanvasGenerationHistoryTasks(
    tasks: GenerationTask[],
    options: { projectId: string; keyword?: string },
) {
    const projectId = options.projectId.trim();
    if (!projectId) return [];
    const keyword = (options.keyword || "").trim().toLocaleLowerCase();
    return tasks
        .filter((task) => task.projectId === projectId)
        .filter((task) => task.status === "succeeded")
        .filter((task) => INSERTABLE_HISTORY_MODES.has(generationTaskMode(task)))
        .filter((task) => !keyword || `${task.prompt} ${task.model || ""}`.toLocaleLowerCase().includes(keyword))
        .slice(0, 60);
}

/** Close / canvas switch / user-scope / unmount after await must not apply the old detail. */
export function canvasGenerationHistorySelectStillValid(
    captured: CanvasGenerationHistorySelectGate,
    live: CanvasGenerationHistorySelectGate,
) {
    if (!captured.mounted || !live.mounted) return false;
    if (!captured.open || !live.open) return false;
    if (captured.selectionEpoch !== live.selectionEpoch) return false;
    const capturedProjectId = captured.projectId.trim();
    const liveProjectId = live.projectId.trim();
    if (!capturedProjectId || capturedProjectId !== liveProjectId) return false;
    return userScopeEpochMatches(captured.epoch, live.epoch);
}

/** Pure detail check: strict id + non-empty project match, success, and usable media. */
export function assertCanvasGenerationHistoryTaskForInsert(
    detail: GenerationTask,
    options: { projectId: string; expectedId: string },
): GenerationTask {
    const projectId = options.projectId.trim();
    const expectedId = options.expectedId.trim();
    const detailId = detail.id?.trim() ?? "";
    const detailProjectId = detail.projectId?.trim() ?? "";
    if (!expectedId || !detailId || detailId !== expectedId) {
        throw new Error("该任务没有可插入的生成结果");
    }
    if (!projectId || !detailProjectId || detailProjectId !== projectId) {
        throw new Error("生成任务不属于当前画布");
    }
    if (detail.status === "failed" || detail.status === "cancelled") {
        throw new Error(detail.error || (detail.status === "cancelled" ? "任务已取消" : "任务失败"));
    }
    if (detail.status !== "succeeded") {
        throw new Error(detail.error || "该任务没有可插入的生成结果");
    }
    if (!INSERTABLE_HISTORY_MODES.has(generationTaskMode(detail))) {
        throw new Error("该任务没有可插入的生成结果");
    }
    if (!historyDetailHasInsertableMedia(detail)) {
        throw new Error("该任务没有可插入的生成结果");
    }
    return detail;
}

/** Await an already-started detail query, then apply only if the picker is still the same canvas. */
export async function awaitCanvasGenerationHistoryDetailIfValid(input: {
    detail: Promise<GenerationTask>;
    captured: CanvasGenerationHistorySelectGate;
    live: () => CanvasGenerationHistorySelectGate;
    expectedId: string;
}): Promise<GenerationTask | undefined> {
    const detail = await input.detail;
    if (!canvasGenerationHistorySelectStillValid(input.captured, input.live())) return undefined;
    return assertCanvasGenerationHistoryTaskForInsert(detail, {
        projectId: input.captured.projectId,
        expectedId: input.expectedId,
    });
}

function historyDetailHasInsertableMedia(task: GenerationTask) {
    if (!task.resultJson?.trim()) return false;
    try {
        const result = JSON.parse(task.resultJson) as {
            images?: Array<{ dataUrl?: string; url?: string; storageKey?: string }>;
            video?: { dataUrl?: string; url?: string; storageKey?: string };
            audio?: { dataUrl?: string; url?: string; storageKey?: string };
        };
        if (!result || typeof result !== "object") return false;
        const mode = generationTaskMode(task);
        const image = result.images?.[0];
        if (mode === "image") return Boolean(image?.dataUrl || image?.url || image?.storageKey);
        if (mode === "video") return Boolean(result.video?.dataUrl || result.video?.url || result.video?.storageKey);
        if (mode === "audio") return Boolean(result.audio?.dataUrl || result.audio?.url || result.audio?.storageKey);
        return false;
    } catch {
        return false;
    }
}
