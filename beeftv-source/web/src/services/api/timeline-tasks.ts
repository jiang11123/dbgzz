import { assertCanonicalPlan, type CanonicalPlanOptions, type CanonicalSourceMeta, type CanonicalTimelinePlan } from "@/lib/timeline/timeline-canonical-plan";
import { ApiError, getTransportFailureKind, http, type HttpRequestConfig } from "@/services/api/request";
import type { GenerationTask } from "@/services/api/task-center";
import type { TimelineProject } from "@/types/timeline";
import type { ChannelModelCatalogItem } from "@/lib/channel-model-catalog";
import { getBeefAPIConnectionEpoch } from "@/services/api/beefapi-connection";
import { UserScopeAbandonedError } from "@/lib/user-scope-guard";

// The local backend may spend 30 seconds fetching the managed catalog before
// admitting a cloud task. Keep a response margin without retrying submissions.
const TRANSCRIPTION_ADMISSION_TIMEOUT_MS = 35_000;

function transcriptionTransportError(error: unknown, submitting: boolean): unknown {
    const kind = getTransportFailureKind(error);
    if (!kind) return error;
    const cause = error instanceof ApiError ? error.cause : error;
    const timedOut = kind === "timeout";
    return new ApiError(submitting
        ? (timedOut ? "转写提交等待超时，任务可能已创建。请先到任务中心确认状态。" : "转写提交连接中断，任务状态尚未确认。请先到任务中心查看。")
        : (timedOut ? "读取转写模型超时，请检查 BeefTV 连接后重试。" : "无法连接转写模型服务，请检查 BeefTV 连接后重试。"),
        { cause, status: error instanceof ApiError ? error.status : undefined });
}

export async function getTranscriptionModels(config?: HttpRequestConfig) {
    const connectionEpoch = getBeefAPIConnectionEpoch();
    try {
        const result = await http.post<{ models: ChannelModelCatalogItem[] }>("/beefapi/connection/models", {}, { timeout: TRANSCRIPTION_ADMISSION_TIMEOUT_MS, ...config });
        if (connectionEpoch !== getBeefAPIConnectionEpoch()) throw new UserScopeAbandonedError();
        return result.models.filter(item => item.supportedEndpointTypes?.includes("audio.transcriptions"));
    } catch (error) { throw transcriptionTransportError(error, false); }
}

// 时间线字幕转写任务 API。
// 创建入参与后端 TimelineTranscriptionCreateRequest 保持同名字段，结果由任务中心统一查询。

export type TimelineTranscriptionCreateRequest = {
    model?: string;
    resourceId: string;
    language?: string;
    projectId?: string;
    clientOperationId?: string;
};

export type TimelineTranscriptionResult = {
    segments: TimelineTranscriptionSegment[];
    srt?: string;
    language?: string;
};

export type TimelineTranscriptionSegment = {
    startMs: number;
    endMs: number;
    text: string;
};

export async function createTimelineTranscriptionTask(
    payload: TimelineTranscriptionCreateRequest,
    config?: HttpRequestConfig,
): Promise<GenerationTask> {
    try {
        return await http.post<GenerationTask>("/timeline/transcriptions", payload, { ...(payload.model ? { timeout: TRANSCRIPTION_ADMISSION_TIMEOUT_MS } : {}), ...config });
    } catch (error) { throw transcriptionTransportError(error, true); }
}

// 时间线成片渲染任务 API。
// timeline 直接传 TimelineProject；后端使用同名字段构建渲染输入，未知字段由后端边界忽略。
// 任务完成后由任务中心读取 ResultJSON，并按 TimelineRenderResult 解包。

export type TimelineRenderCreateRequest = {
    projectId: string;
    timeline: TimelineProject;
    options?: CanonicalPlanOptions;
    clientOperationId?: string;
};

export type TimelineRenderResult = {
    resourceId: string;
    fileName?: string;
    size?: number;
    durationMs?: number;
    subtitleSrt?: string;
};

export async function createTimelineRenderTask(
    payload: TimelineRenderCreateRequest,
    config?: HttpRequestConfig,
): Promise<GenerationTask> {
    return http.post<GenerationTask>("/timeline/renders", payload, config);
}

export type TimelineRenderPlanCompileRequest = {
    timeline: TimelineProject;
    sources?: CanonicalSourceMeta[];
    options?: CanonicalPlanOptions;
};

/** 只读规划：不排队、不落盘、不计费。失败必须上抛，导出不得改走本地语义编译。 */
export async function compileTimelineRenderPlan(
    payload: TimelineRenderPlanCompileRequest,
    signal?: AbortSignal,
): Promise<CanonicalTimelinePlan> {
    const plan = await http.post<CanonicalTimelinePlan>("/timeline/render-plan", payload, { signal });
    assertCanonicalPlan(plan);
    return plan;
}
