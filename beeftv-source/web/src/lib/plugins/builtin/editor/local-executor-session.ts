import { createClientId } from "@/lib/client-id";
import { assertUserScope, captureUserScope, isUserScopeAbandonedError, type CapturedUserScope } from "@/lib/user-scope-guard";
import { createDepthCaptureTask, type DepthCaptureResult } from "@/services/api/depth-capture";
import { getResource, type RemoteResource } from "@/services/api/resources";
import { waitForGenerationTask, type GenerationTask } from "@/services/api/task-center";
import {
    createTimelineRenderTask,
    createTimelineTranscriptionTask,
    type TimelineRenderResult,
    type TimelineTranscriptionResult,
} from "@/services/api/timeline-tasks";
import type { TimelineProject } from "@/types/timeline";

/**
 * One captured account epoch plus the project/mount that started a local-executor
 * run. Epoch is the only identity clock; project/mount use the existing abort
 * signal so a late completion cannot write to a replacement panel.
 */
export type LocalExecutorSession = {
    expectedScope: CapturedUserScope;
    projectId: string;
    controller: AbortController;
    getLiveProjectId: () => string;
};

export type LocalExecutorIntentState = {
    clientOperationId: string;
    submittedTaskId?: string;
    frozenInputKey?: string;
    terminal?: boolean;
};

export function localExecutorFrozenInputKey(parts: Array<string | number | null | undefined | object>) {
    return JSON.stringify(parts);
}

export function beginLocalExecutorSession(
    projectId: string,
    options: {
        controller: AbortController;
        getLiveProjectId: () => string;
        expectedScope?: CapturedUserScope;
    },
): LocalExecutorSession {
    return {
        expectedScope: options.expectedScope ?? captureUserScope(),
        projectId,
        controller: options.controller,
        getLiveProjectId: options.getLiveProjectId,
    };
}

export function assertLocalExecutorSession(session: LocalExecutorSession) {
    if (session.controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
    assertUserScope(session.expectedScope);
    if (session.getLiveProjectId() !== session.projectId) {
        session.controller.abort();
        throw new DOMException("Aborted", "AbortError");
    }
}

export function isLocalExecutorSessionStop(error: unknown) {
    return isUserScopeAbandonedError(error) || (error instanceof Error && error.name === "AbortError");
}

export function nextLocalExecutorClientOperationId(
    previous?: Partial<LocalExecutorIntentState> | null,
    currentInputKey?: string,
) {
    if (
        previous?.clientOperationId
        && !previous.submittedTaskId
        && !previous.terminal
        && (!currentInputKey || !previous.frozenInputKey || previous.frozenInputKey === currentInputKey)
    ) {
        return previous.clientOperationId;
    }
    return createClientId();
}

export function localExecutorIntentAfterSubmit(
    clientOperationId: string,
    task: GenerationTask,
    previous?: Partial<LocalExecutorIntentState>,
): LocalExecutorIntentState {
    return {
        clientOperationId: task.clientOperationId || clientOperationId,
        submittedTaskId: task.id,
        frozenInputKey: previous?.frozenInputKey,
    };
}

export function isUncertainLocalExecutorSubmit(error: unknown, submittedTaskId?: string) {
    if (submittedTaskId || isLocalExecutorSessionStop(error)) return false;
    const status = error && typeof error === "object" && "status" in error ? Number((error as { status?: unknown }).status) : Number.NaN;
    if (Number.isFinite(status) && status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 429) return false;
    return true;
}

export function localExecutorIntentAfterError(intent: LocalExecutorIntentState, error: unknown): LocalExecutorIntentState {
    if (isUncertainLocalExecutorSubmit(error, intent.submittedTaskId)) {
        return { clientOperationId: intent.clientOperationId, frozenInputKey: intent.frozenInputKey };
    }
    return { ...intent, terminal: true };
}

export async function attachLocalExecutorResult<T>(session: LocalExecutorSession, attach: () => T | Promise<T>): Promise<T> {
    assertLocalExecutorSession(session);
    const result = await attach();
    assertLocalExecutorSession(session);
    return result;
}

export async function observeLocalExecutorTask(
    taskId: string,
    session: LocalExecutorSession,
    options: {
        initialTask?: GenerationTask;
        intervalMs?: number;
        timeoutMs?: number;
        onTaskUpdate?: (task: GenerationTask) => void;
    } = {},
) {
    assertLocalExecutorSession(session);
    const done = await waitForGenerationTask(taskId, {
        initialTask: options.initialTask,
        intervalMs: options.intervalMs,
        timeoutMs: options.timeoutMs,
        signal: session.controller.signal,
        expectedScope: session.expectedScope,
        onTaskUpdate: (task) => {
            assertLocalExecutorSession(session);
            options.onTaskUpdate?.(task);
        },
    });
    assertLocalExecutorSession(session);
    return done;
}

export async function runOwnedTimelineRender(input: {
    session: LocalExecutorSession;
    projectId: string;
    timeline: TimelineProject;
    clientOperationId: string;
    onCreated?: (task: GenerationTask) => void;
    onTaskUpdate?: (task: GenerationTask) => void;
    timeoutMs?: number;
    intervalMs?: number;
}): Promise<{ task: GenerationTask; result: TimelineRenderResult }> {
    assertLocalExecutorSession(input.session);
    const created = await createTimelineRenderTask(
        { projectId: input.projectId, timeline: input.timeline, clientOperationId: input.clientOperationId },
        { signal: input.session.controller.signal, expectedScope: input.session.expectedScope },
    );
    assertLocalExecutorSession(input.session);
    input.onCreated?.(created);
    const task = await observeLocalExecutorTask(created.id, input.session, {
        initialTask: created,
        timeoutMs: input.timeoutMs ?? 62 * 60 * 1000,
        intervalMs: input.intervalMs ?? 3000,
        onTaskUpdate: input.onTaskUpdate,
    });
    const result = JSON.parse(task.resultJson ?? "{}") as TimelineRenderResult;
    if (!result.resourceId) throw new Error("渲染任务未返回产物");
    assertLocalExecutorSession(input.session);
    return { task, result };
}

export async function runOwnedTimelineTranscription(input: {
    model?: string;
    session: LocalExecutorSession;
    resourceId: string;
    projectId?: string;
    language?: string;
    clientOperationId: string;
    onCreated?: (task: GenerationTask) => void;
    onTaskUpdate?: (task: GenerationTask) => void;
    timeoutMs?: number;
    intervalMs?: number;
}): Promise<{ task: GenerationTask; result: TimelineTranscriptionResult }> {
    assertLocalExecutorSession(input.session);
    const created = await createTimelineTranscriptionTask(
        {
            resourceId: input.resourceId,
            projectId: input.projectId,
            language: input.language,
            model: input.model,
            clientOperationId: input.clientOperationId,
        },
        { signal: input.session.controller.signal, expectedScope: input.session.expectedScope },
    );
    assertLocalExecutorSession(input.session);
    input.onCreated?.(created);
    const task = await observeLocalExecutorTask(created.id, input.session, {
        initialTask: created,
        timeoutMs: input.timeoutMs ?? 25 * 60 * 1000,
        intervalMs: input.intervalMs ?? 2000,
        onTaskUpdate: input.onTaskUpdate,
    });
    const result = JSON.parse(task.resultJson ?? "{}") as TimelineTranscriptionResult;
    assertLocalExecutorSession(input.session);
    return { task, result };
}

export async function runOwnedDepthCapture(input: {
    session: LocalExecutorSession;
    projectId: string;
    resourceId: string;
    nodeId?: string;
    clientOperationId: string;
    onCreated?: (task: GenerationTask) => void | Promise<void>;
    onTaskUpdate?: (task: GenerationTask) => void;
    timeoutMs?: number;
    intervalMs?: number;
}): Promise<{ task: GenerationTask; resource: RemoteResource; capture: DepthCaptureResult }> {
    assertLocalExecutorSession(input.session);
    const created = await createDepthCaptureTask(
        { projectId: input.projectId, nodeId: input.nodeId, resourceId: input.resourceId, clientOperationId: input.clientOperationId },
        { signal: input.session.controller.signal, expectedScope: input.session.expectedScope },
    );
    assertLocalExecutorSession(input.session);
    await input.onCreated?.(created);
    const task = await observeLocalExecutorTask(created.id, input.session, {
        initialTask: created,
        timeoutMs: input.timeoutMs,
        intervalMs: input.intervalMs ?? 1000,
        onTaskUpdate: input.onTaskUpdate,
    });
    const capture = JSON.parse(task.resultJson || "{}") as DepthCaptureResult;
    if (!capture.resourceId) throw new Error("任务完成但没有返回深度视频资源");
    assertLocalExecutorSession(input.session);
    const resource = await getResource(capture.resourceId, {
        signal: input.session.controller.signal,
        expectedScope: input.session.expectedScope,
    });
    assertLocalExecutorSession(input.session);
    return { task, resource, capture };
}
