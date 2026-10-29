import { isCanvasRevisionConflict } from "@/services/canvas-revision-conflict";
import { explainGenerationError } from "@/lib/generation-error";

export class CanvasGenerationDurableAckError extends Error {
    readonly code: "canvas_conflict" | "result_apply_failed" | "result_target_unavailable";
    readonly cause: unknown;

    constructor(cause: unknown) {
        const explanation = explainGenerationError(cause);
        const code = isCanvasRevisionConflict(cause) ? "canvas_conflict" : explanation.category === "result_target_unavailable" ? "result_target_unavailable" : "result_apply_failed";
        super(code === "canvas_conflict" ? "生成结果已保留，画布尚未更新" : code === "result_target_unavailable" ? explanation.message : "生成结果已保留，还没放回画布");
        this.name = "CanvasGenerationDurableAckError";
        this.code = code;
        this.cause = cause;
    }
}

export class CanvasGenerationMaterializationError extends Error {
    readonly code = "download_failed";
    readonly cause: unknown;

    constructor(cause?: unknown) {
        super("生成结果还没取回，可以继续取回");
        this.name = "CanvasGenerationMaterializationError";
        this.cause = cause;
    }
}

export class CanvasGenerationTargetSaveError extends Error {
    constructor(cause?: unknown, message = "画布尚未保存，未开始生成。请先处理画布保存提示后重试。") {
        super(message, { cause });
        this.name = "CanvasGenerationTargetSaveError";
    }
}

export class CanvasGenerationOutputMissingError extends Error {
    readonly code = "results_missing";
    constructor(index: number) {
        super(`原任务未返回第 ${index + 1} 张图片，已有结果已保留，请查看任务详情`);
        this.name = "CanvasGenerationOutputMissingError";
    }
}
