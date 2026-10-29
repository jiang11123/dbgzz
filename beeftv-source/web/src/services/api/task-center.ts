import { generationErrorMessage } from "@/lib/generation-error";
import { GENERATION_RESULT_FETCH_STAGE } from "@/lib/generation-delivery-progress";
import { assertUserScope, captureUserScope, isUserScopeAbandonedError, type CapturedUserScope } from "@/lib/user-scope-guard";
import { ApiError, http, apiBaseURL, type BackendEnvelope, type HttpRequestConfig } from "@/services/api/request";
import { consumeTaskTextStream, createTaskTextStreamParser, type TaskTextStreamEvent } from "@/services/api/task-text-stream";
import { getDiagnosticTraceId, recordDiagnosticEvent } from "@/services/diagnostics/client-diagnostics";
import { publishGenerationDeliveryProgress } from "@/stores/use-generation-delivery-progress";
import { beginTaskReferenceObservation, publishTaskReferenceProgress } from "@/services/task-reference-progress";

export type { BackendEnvelope } from "@/services/api/request";

export type TaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type ProviderCancelStatus = "requested" | "confirmed" | "uncertain";
export type GenerationTaskResultState = "NOT_AVAILABLE" | "PENDING_MATERIALIZATION" | "MATERIALIZING" | "READY" | "FAILED_RETRYABLE" | "FAILED_PERMANENT";
export type GenerationTaskOutput = {
    outputIndex: number;
    mediaType: "image" | "video" | "audio";
    providerArtifactRef?: string;
    materializedAssetId?: string;
    materializationErrorCode?: string;
};

export type GenerationTaskDeliveryProgress = {
    outputIndex: number;
    downloadedBytes: number;
    /** -1 when the remote size is unknown. */
    totalBytes: number;
    bytesPerSecond: number;
    updatedAt?: number;
    state: "downloading" | "retrying" | "waiting";
};

export type GenerationTask = {
    failureDiagnostics?: import("@/lib/generation-error").GenerationFailureDiagnostics;
    id: string;
    traceId?: string;
    clientOperationId?: string;
    retryOf?: string;
    attemptGroupId?: string;
    projectId?: string;
    type: string;
    status: TaskStatus;
    progress?: number;
    stage?: string;
    prompt: string;
    operation?: string;
    provider?: string;
    model?: string;
    providerRequestId?: string;
    providerCancelStatus?: ProviderCancelStatus;
    providerCancelError?: string;
    providerCancelAttempts?: number;
    providerCancelRequestedAt?: string;
    providerCancelledAt?: string;
    errorCode?: string;
    officialStatus?: "pending" | "processing" | "completed" | "failed" | "cancelled";
    receiptRecorded?: boolean;
    previewUrl?: string;
    previewKind?: "image" | "video";
    previewPosterUrl?: string;
    inputJson?: string;
    resultJson?: string;
    resultState?: GenerationTaskResultState;
    outputs?: GenerationTaskOutput[];
    /** Present only while the backend is fetching a result to local storage. */
    delivery?: { outputs: GenerationTaskDeliveryProgress[] };
    referenceProgress?: { label: string; phase: "preparing" | "transferring" | "processing"; loadedBytes: number; totalBytes: number; bytesPerSecond: number; startedAt: number; updatedAt: number };
    textDraft?: string;
    error?: string;
    attempts: number;
    startedAt?: string;
    completedAt?: string;
    createdAt: string;
    updatedAt: string;
    clientContext?: {
        source?: string;
        sceneId?: string;
        conversationId?: string;
        messageId?: string;
        nodeId?: string;
        batchIndex?: number;
        batchCount?: number;
        domainProjectId?: string;
        chapterId?: string;
		chapterOperation?: "characters" | "storyboard";
		shotId?: string;
		workflowStepId?: string;
		artifactType?: string;
	};
    created_at?: string;
    updated_at?: string;
};

export type ProviderTaskQueryResult = {
    task: GenerationTask;
    providerStatus: string;
    recovered: boolean;
};

export type TaskTextDelta = {
    id: string;
    taskId: string;
    sequence: number;
    content: string;
    byteCount: number;
    createdAt: string;
    expiresAt: string;
};

export type TaskTextReplay = {
    deltas: TaskTextDelta[];
    textDraft?: string;
    finalText?: string;
    complete: boolean;
    status: TaskStatus;
    stage?: string;
    progress: number;
    error?: string;
};

export type TaskLog = {
    summary?: string;
    id: string;
    taskId: string;
    level: "info" | "warn" | "error";
    stage: string;
    errorCode?: string;
    provenance: "task_state" | "provider_observation" | "background_reconcile" | "manual_refresh" | "backend";
    observedAt?: string;
    createdAt: string;
};

export type CreateTaskInput = {
    projectId?: string;
    type?: string;
    operation?: string;
    prompt: string;
    provider?: string;
    model?: string;
	logicalModelId?: string;
    input?: Record<string, unknown>;
};
export function createGenerationTask(input: CreateTaskInput, config?: HttpRequestConfig) {
    return http.post<GenerationTask>("/tasks", input, config).then((task) => {
        recordDiagnosticEvent({ level: "info", category: "task", code: "task_created", message: "任务已创建", taskId: task.id, projectId: task.projectId, canvasId: task.projectId, nodeId: task.clientContext?.nodeId, clientOperationId: task.clientOperationId, traceId: task.traceId || getDiagnosticTraceId(task.id) });
        notifyCanvasTaskCreated(task);
        return task;
    });
}

export type GenerationTaskPageRequest = {
    limit: number;
    projectId?: string;
    activeOnly: boolean;
    cursor?: string;
};

/** A missing receipt never authorizes another paid generation. */
export async function findGenerationTaskByOperation(operationId: string, projectId: string, signal?: AbortSignal): Promise<GenerationTask | undefined> {
    try {
        return await http.get<GenerationTask>(`/tasks/by-operation/${encodeURIComponent(operationId)}`, { params: { projectId }, signal });
    } catch (error) {
        if (error instanceof ApiError && error.status === 404) return undefined;
        throw error;
    }
}

type GenerationTaskPage<T> = { tasks: T[]; nextCursor?: string };
type GenerationTaskListOptions = { projectId?: string; activeOnly?: boolean };
type GenerationTaskListDependencies = {
    listBackend?(limit: number, options?: GenerationTaskListOptions, signal?: AbortSignal): Promise<GenerationTask[]>;
    listBackendPage?(request: GenerationTaskPageRequest, signal?: AbortSignal): Promise<GenerationTaskPage<GenerationTask>>;
};

const defaultGenerationTaskListDependencies: GenerationTaskListDependencies = {
    listBackendPage: async (page, signal) => ({
        tasks: await http.get<GenerationTask[]>("/tasks", {
                params: { pageSize: Math.min(page.limit, 100), projectId: page.projectId, activeOnly: page.activeOnly || undefined },
                signal,
            }),
    }),
};

export async function listGenerationTasks(limit = 30, options?: { projectId?: string; activeOnly?: boolean }, dependencies: GenerationTaskListDependencies = defaultGenerationTaskListDependencies, signal?: AbortSignal) {
    const expected = captureUserScope();
    const observationRequest = beginTaskReferenceObservation();
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const boundedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(10_000, Math.trunc(limit))) : 30;
    const baseRequest = {
        limit: Math.min(100, boundedLimit),
        ...(options?.projectId ? { projectId: options.projectId } : {}),
        activeOnly: options?.activeOnly === true,
    } satisfies GenerationTaskPageRequest;
    const backendPageReader =
        dependencies.listBackendPage ??
        (async (page: GenerationTaskPageRequest, pageSignal?: AbortSignal) => ({
            tasks:
                (await dependencies.listBackend?.(
                    page.limit,
                    {
                        ...(page.projectId ? { projectId: page.projectId } : {}),
                        activeOnly: page.activeOnly,
                    },
                    pageSignal,
                )) ?? [],
        }));
    const backendTasks = await collectGenerationTaskPages(backendPageReader, baseRequest, boundedLimit, signal);
    assertUserScope(expected);
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    backendTasks.forEach(task => publishTaskReferenceProgress(task, expected, observationRequest));
    return backendTasks
        .filter((task) => !options?.projectId || task.projectId === options.projectId)
        .filter((task) => !options?.activeOnly || task.status === "queued" || task.status === "running")
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))
        .slice(0, boundedLimit);
}

async function collectGenerationTaskPages<T>(readPage: (request: GenerationTaskPageRequest, signal?: AbortSignal) => Promise<GenerationTaskPage<T>>, baseRequest: GenerationTaskPageRequest, limit: number, signal?: AbortSignal) {
    const items: T[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const response = await readPage({ ...baseRequest, ...(cursor ? { cursor } : {}) }, signal);
        const page = Array.isArray(response) ? { tasks: response as T[] } : response;
        items.push(...page.tasks);
        if (!page.nextCursor || seenCursors.has(page.nextCursor)) break;
        seenCursors.add(page.nextCursor);
        cursor = page.nextCursor;
    } while (items.length < limit);
    return items.slice(0, limit);
}

export function queryGenerationTask(id: string, options?: { signal?: AbortSignal; expectedScope?: CapturedUserScope }) {
    const expected = options?.expectedScope ?? captureUserScope();
    const observationRequest = beginTaskReferenceObservation();
    return http.get<GenerationTask>(`/tasks/${encodeURIComponent(id)}`, { signal: options?.signal, expectedScope: expected }).then(task => {
        assertUserScope(expected);
        if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        publishTaskReferenceProgress(task, expected, observationRequest);
        return task;
    });
}

type GenerationTaskSubscriptionDependencies = {
    queryTask(id: string): Promise<GenerationTask>;
    waitTask(id: string, options?: { initialTask?: GenerationTask; onTaskUpdate?: (task: GenerationTask) => void }): Promise<GenerationTask>;
    notifyTaskChanged?: (task: GenerationTask) => void;
};

export function createGenerationTaskSubscriptionService(dependencies: GenerationTaskSubscriptionDependencies) {
    type Entry = {
        listeners: Set<(task: GenerationTask) => void>;
        latest?: GenerationTask;
        observation?: Promise<void>;
    };
    const entries = new Map<string, Entry>();
    const publish = (entry: Entry, task: GenerationTask) => {
        entry.latest = task;
        for (const listener of entry.listeners) listener(task);
        // Auxiliary broadcast failures must never prevent direct subscribers
        // from receiving a durable task update.
        try {
            if (dependencies.notifyTaskChanged) dependencies.notifyTaskChanged(task);
            else if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
                window.dispatchEvent(new CustomEvent("canvas:task-updated", { detail: { task } }));
            }
        } catch (error) {
            console.warn("生成任务的辅助通知失败，本地订阅者已正常更新", { taskId: task.id, error });
        }
    };
    const observe = (id: string, entry: Entry) => {
        if (entry.observation) return entry.observation;
        const observation = (async () => {
            const initial = await dependencies.queryTask(id);
            publish(entry, initial);
            if (initial.status === "succeeded" || initial.status === "failed" || initial.status === "cancelled") return;
            const terminal = await dependencies.waitTask(id, {
                initialTask: initial,
                onTaskUpdate: (task) => publish(entry, task),
            });
            publish(entry, terminal);
        })().catch((error) => {
            // 观察失败不能永久占住 entry，否则页面重新订阅时也不会再查询任务。
            // Only clear this attempt: a newer subscriber may already have
            // installed its replacement while this rejection was settling.
            if (entry.observation === observation) entry.observation = undefined;
            console.warn("生成任务观察中断，后续订阅将重新建立连接", { taskId: id, error });
        });
        entry.observation = observation;
        return observation;
    };
    return {
        subscribe(ids: readonly string[], listener: (task: GenerationTask) => void) {
            const uniqueIds = [...new Set(ids)];
            for (const id of uniqueIds) {
                const entry = entries.get(id) ?? { listeners: new Set<(task: GenerationTask) => void>() };
                entries.set(id, entry);
                entry.listeners.add(listener);
                if (entry.latest) listener(entry.latest);
                const activeObservation = observe(id, entry);
                // A subscriber can arrive after an observation has rejected but
                // before its catch handler clears the shared promise. Hand off
                // once that promise settles so this live subscriber cannot be
                // stranded in that narrow cleanup window.
                void activeObservation?.then(() => {
                    if (entry.listeners.has(listener) && !entry.observation) observe(id, entry);
                });
            }
            return () => {
                for (const id of uniqueIds) entries.get(id)?.listeners.delete(listener);
            };
        },
    };
}

const generationTaskSubscriptionService = createGenerationTaskSubscriptionService({
    queryTask: (id) => queryGenerationTask(id),
    waitTask: (id, options) => waitForGenerationTask(id, options),
});

export function subscribeGenerationTasks(ids: readonly string[], listener: (task: GenerationTask) => void) {
    return generationTaskSubscriptionService.subscribe(ids, listener);
}

export function appendTaskTextDelta(id: string, content: string) {
    return http.post<TaskTextDelta>(`/tasks/${encodeURIComponent(id)}/text-deltas`, { content });
}

export function completeTextReplayTask(id: string, text: string) {
    return http.post<GenerationTask>(`/tasks/${encodeURIComponent(id)}/text-replay-complete`, { text });
}

export function queryTaskTextReplay(id: string, after = 0) {
    return http.get<TaskTextReplay>(`/tasks/${encodeURIComponent(id)}/text-deltas`, { params: { after } });
}

export function retryGenerationTask(id: string, options?: { signal?: AbortSignal; expectedScope?: CapturedUserScope }) {
    return http.post<GenerationTask>(`/tasks/${encodeURIComponent(id)}/retry`, undefined, options);
}

export function cancelGenerationTask(id: string, expectedScope = captureUserScope()) {
    return http.post<GenerationTask>(`/tasks/${encodeURIComponent(id)}/cancel`, undefined, { expectedScope }).then((task) => {
        window.dispatchEvent(new CustomEvent("canvas:task-cancelled", { detail: { task } }));
        return task;
    });
}

export function queryFailedVideoProviderTask(id: string) {
    return http.post<ProviderTaskQueryResult>(`/tasks/${encodeURIComponent(id)}/query-provider`);
}

export function canRetrieveVideoResult(task: GenerationTask) {
    return task.status === "failed" && (task.type.startsWith("canvas_video") || task.type.startsWith("video_")) && Boolean(task.providerRequestId);
}

export function refreshGenerationTaskStatus(id: string, options?: { signal?: AbortSignal }) {
    return http.get<GenerationTask>(`/tasks/${encodeURIComponent(id)}`, { signal: options?.signal });
}

export function deleteGenerationTask(id: string) {
    return http.delete<void>(`/tasks/${encodeURIComponent(id)}`);
}

export async function listTaskLogs(id: string, options?: { signal?: AbortSignal }) {
    const raw = await http.get<Array<{ summary?: unknown; level?: unknown; message?: unknown; payload?: unknown; createdAt?: unknown }>>(`/tasks/${encodeURIComponent(id)}/logs`, { signal: options?.signal });
    return raw.map((log, index) => projectBackendSafeTaskLog(id, log, index));
}

export function formatTaskLog(log: TaskLog) {
    if (log.summary) return log.summary;
    return [`stage=${log.stage}`, ...(log.errorCode ? [`error=${log.errorCode}`] : []), `provenance=${log.provenance}`, ...(log.observedAt ? [`observedAt=${log.observedAt}`] : [])].join(" ");
}

export function projectBackendSafeTaskLog(taskId: string, raw: { summary?: unknown; level?: unknown; message?: unknown; payload?: unknown; createdAt?: unknown }, index: number): TaskLog {
    const text = [raw.message, raw.payload].filter((value): value is string => typeof value === "string").join(" ");
    const stage = safeTaskLogStage(text) || "backend_event";
    const errorCode = safeTaskLogErrorCode(text);
    const createdAt = typeof raw.createdAt === "string" && Number.isFinite(Date.parse(raw.createdAt)) ? raw.createdAt : "1970-01-01T00:00:00.000Z";
    return {
        id: `safe:${taskId}:${index}`,
        ...(typeof raw.summary === "string" ? { summary: raw.summary } : {}),
        taskId,
        level: raw.level === "error" ? "error" : raw.level === "warn" ? "warn" : "info",
        stage,
        ...(errorCode ? { errorCode } : {}),
        provenance: "backend",
        createdAt,
    };
}

function safeTaskLogStage(value: unknown) {
    if (typeof value !== "string") return undefined;
    const match = value.match(/(?:^|[^a-z0-9_])(queued|submitting|submitted|generating|submission_unknown|processing|completed|succeeded|failed|cancelled)(?:$|[^a-z0-9_])/i);
    return match?.[1]?.toLowerCase();
}

const SAFE_TASK_LOG_ERROR_CODES = new Set(["provider_query_failed", "provider_submission_unknown", "provider_reference_invalid"]);

function safeTaskLogErrorCode(value: unknown) {
    if (typeof value !== "string") return undefined;
    for (const match of value.matchAll(/(?:model|provider)_[a-z0-9_]{2,80}/gi)) {
        const errorCode = match[0].toLowerCase();
        if (SAFE_TASK_LOG_ERROR_CODES.has(errorCode)) return errorCode;
    }
    return undefined;
}

export type WaitForGenerationTaskOptions = {
    signal?: AbortSignal;
    intervalMs?: number;
    timeoutMs?: number;
    initialTask?: GenerationTask;
    onTaskUpdate?: (task: GenerationTask) => void;
    onTextDelta?: (text: string) => void;
    useTextEvents?: boolean;
    expectedScope?: CapturedUserScope;
};

export function shouldUseTaskTextEvents(options?: Pick<WaitForGenerationTaskOptions, "onTextDelta" | "useTextEvents">) {
    return Boolean(options?.onTextDelta || options?.useTextEvents);
}

export async function waitForGenerationTask(id: string, options?: WaitForGenerationTaskOptions) {
    if (shouldUseTaskTextEvents(options)) return waitForGenerationTaskTextEvents(id, options || {});
    const startedAt = Date.now();
    const intervalMs = options?.intervalMs || 2000;
    let lastTask = options?.initialTask;
    let lastQueryError: unknown;
    let consecutiveFailures = 0;
    // Only the progress this waiter published is cleared on exit, so a second
    // waiter for the same task keeps its own view.
    let publishedDelivery = false;
    try {
        while (Date.now() - startedAt < (options?.timeoutMs || taskWaitTimeoutMs(lastTask))) {
            if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
            let task: GenerationTask;
            try {
                task = await queryGenerationTask(id, { signal: options?.signal, expectedScope: options?.expectedScope });
                if (options?.expectedScope) assertUserScope(options.expectedScope);
                lastTask = task;
                lastQueryError = undefined;
                consecutiveFailures = 0;
                options?.onTaskUpdate?.(task);
            } catch (error) {
                if (isUserScopeAbandonedError(error)) throw error;
                lastQueryError = error;
                consecutiveFailures += 1;
                // 连续失败说明查询通道已不可用，继续轮询只会空转到整体超时；
                // 保留少量容忍度（约 10 秒）以跳过瞬时抖动后直接报错，便于用户尽早处理。
                if (consecutiveFailures >= 5) {
                    throw error instanceof Error ? error : new Error(String(error));
                }
                await delay(intervalMs, options?.signal);
                continue;
            }
            if (task.status === "queued" || task.status === "running") {
                const progress = task.delivery?.outputs[0];
                if (progress) {
                    publishGenerationDeliveryProgress(id, progress);
                    publishedDelivery = true;
                } else if (publishedDelivery) {
                    publishGenerationDeliveryProgress(id, undefined);
                    publishedDelivery = false;
                }
            }
            if (task.status === "succeeded") {
                return task;
            }
            if (task.status === "failed" || task.status === "cancelled") {
                throw new Error(task.error ? generationErrorMessage(task.error) : `任务${task.status === "cancelled" ? "已取消" : "失败"}`);
            }
            const retrieving = Boolean(task.delivery) || task.stage === GENERATION_RESULT_FETCH_STAGE;
            await delay(retrieving ? Math.min(intervalMs, 500) : intervalMs, options?.signal);
        }
    } catch (error) {
        if (options?.signal?.aborted) {
            // Abort 只停止当前页面的状态监听，不能把已发起的上游任务改成取消状态。
            throw new DOMException("Aborted", "AbortError");
        }
        throw error;
    } finally {
        if (publishedDelivery) publishGenerationDeliveryProgress(id, undefined);
    }
    throw new Error(lastQueryError instanceof Error ? `任务状态同步失败：${lastQueryError.message}` : "任务执行超时，请稍后重试");
}

async function waitForGenerationTaskTextEvents(id: string, options: WaitForGenerationTaskOptions) {
    const startedAt = Date.now();
    const intervalMs = options.intervalMs || 1000;
    let lastTask = options.initialTask;
    let lastEventId = 0;
    // 已有草稿先落到文本里，重开对话时同一批增量不会被当成新内容重复拼接。
    let fullText = lastTask?.textDraft || "";
    let lastStreamError: unknown;
    if (!lastTask) {
        lastTask = await queryGenerationTask(id, { signal: options.signal, expectedScope: options.expectedScope });
        if (options.expectedScope) assertUserScope(options.expectedScope);
        options.onTaskUpdate?.(lastTask);
    }
    const timeoutMs = options.timeoutMs || taskWaitTimeoutMs(lastTask);
    while (Date.now() - startedAt < timeoutMs) {
        if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        if (options.expectedScope) assertUserScope(options.expectedScope);
        let terminalReceived = false;
        try {
            const base = String(apiBaseURL).replace(/\/+$/, "");
            const cursor = lastEventId > 0 ? `?after=${encodeURIComponent(String(lastEventId))}` : "";
            const path = `/tasks/${encodeURIComponent(id)}/text-events`;
            const response = await fetch(`${base}${path}${cursor}`, {
                headers: { Accept: "text/event-stream" },
                credentials: "include",
                signal: options.signal,
            });
            if (!response.ok) throw new TaskTextStreamFatalError(await taskTextStreamHTTPError(response));
            if (!(response.headers.get("content-type") || "").toLowerCase().includes("text/event-stream")) {
                throw new TaskTextStreamFatalError("任务文本流接口未返回事件流，请检查后端地址和反向代理配置");
            }
            if (!response.body) throw new Error("任务文本流不可用");
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            const parser = createTaskTextStreamParser();
            const onEvent = (event: TaskTextStreamEvent) => {
                if (options.expectedScope) assertUserScope(options.expectedScope);
                const payload = asTaskTextStreamRecord(event.data);
                if (event.event === "delta") {
                    const sequence = numberValue(payload.sequence) || event.id || 0;
                    if (sequence <= lastEventId) return;
                    const content = typeof payload.content === "string" ? payload.content : "";
                    lastEventId = sequence;
                    if (!content) return;
                    fullText += content;
                    options.onTextDelta?.(fullText);
                    if (lastTask) {
                        lastTask = { ...lastTask, textDraft: fullText };
                        options.onTaskUpdate?.(lastTask);
                    }
                    return;
                }
                if (event.event === "progress") {
                    if (!lastTask) return;
                    lastTask = {
                        ...lastTask,
                        ...(isTaskStatus(payload.status) ? { status: payload.status } : {}),
                        ...(typeof payload.stage === "string" ? { stage: payload.stage } : {}),
                        ...(numberValue(payload.progress) !== undefined ? { progress: numberValue(payload.progress) } : {}),
                    };
                    options.onTaskUpdate?.(lastTask);
                    return;
                }
                if (event.event === "terminal") {
                    terminalReceived = true;
                    if (typeof payload.finalText === "string" && payload.finalText !== fullText) {
                        fullText = payload.finalText;
                        options.onTextDelta?.(fullText);
                    }
                    return;
                }
                if (event.event === "error") throw new Error(typeof payload.message === "string" ? payload.message : "任务文本流不可用");
            };
            try {
                for (;;) {
                    const { done, value } = await reader.read();
                    if (options.expectedScope) assertUserScope(options.expectedScope);
                    if (done) break;
                    consumeTaskTextStream(parser, decoder.decode(value, { stream: true }), onEvent);
                }
                consumeTaskTextStream(parser, decoder.decode(), onEvent, true);
            } finally {
                await reader.cancel().catch(() => undefined);
                reader.releaseLock();
            }
            if (terminalReceived) {
                const completed = await queryGenerationTask(id, { signal: options.signal, expectedScope: options.expectedScope });
                if (options.expectedScope) assertUserScope(options.expectedScope);
                options.onTaskUpdate?.(completed);
                if (completed.status === "succeeded") return completed;
                if (completed.status === "failed" || completed.status === "cancelled") {
                    throw new TaskTextStreamFatalError(completed.error ? generationErrorMessage(completed.error) : `任务${completed.status === "cancelled" ? "已取消" : "失败"}`);
                }
            }
            lastStreamError = new Error("任务文本流连接提前结束");
        } catch (error) {
            if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
            if (isUserScopeAbandonedError(error)) throw error;
            if (error instanceof TaskTextStreamFatalError) throw error;
            lastStreamError = error;
        }
        await delay(intervalMs, options.signal);
    }
    throw new Error(lastStreamError instanceof Error ? `任务文本流同步失败：${lastStreamError.message}` : "任务执行超时，请稍后重试");
}

function asTaskTextStreamRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numberValue(value: unknown) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isTaskStatus(value: unknown): value is TaskStatus {
    return value === "queued" || value === "running" || value === "succeeded" || value === "failed" || value === "cancelled";
}

class TaskTextStreamFatalError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "TaskTextStreamFatalError";
    }
}

async function taskTextStreamHTTPError(response: Response) {
    try {
        const payload = await response.json() as { msg?: unknown };
        if (typeof payload.msg === "string" && payload.msg.trim()) return payload.msg;
    } catch {
        // SSE 错误响应可能是空正文或网关 HTML，只返回状态码，避免泄露正文。
    }
    return `任务文本流请求失败（HTTP ${response.status}）`;
}

function taskWaitTimeoutMs(task?: GenerationTask) {
    const type = task?.type || "";
    if (type === "depth_capture") return 122 * 60 * 1000;
    if (type.includes("storyboard")) return 13 * 60 * 1000;
    if (type.includes("video")) return 32 * 60 * 1000;
    if (type.includes("image")) return 10 * 60 * 1000;
    if (type.includes("text") || type.includes("audio")) return 12 * 60 * 1000;
    return 10 * 60 * 1000;
}

function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                window.clearTimeout(timer);
                reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
        );
    });
}

function notifyCanvasTaskCreated(task: GenerationTask) {
    if (typeof window === "undefined" || !task.projectId) return;
    window.dispatchEvent(new CustomEvent("canvas:task-created", { detail: { task } }));
}
