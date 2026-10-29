// 默认由后端 ffmpeg 渲染并把产物写入资源存储；浏览器 ffmpeg.wasm 只承担离线降级。
// 缺源阻止完整成片导出；规划错误在面板呈现，不中断编辑器。

import { useEffect, useMemo, useRef, useState } from "react";
import { Download, Loader2, PackageOpen, Server } from "lucide-react";

import { useEditorHostContext, useEditorStoreContext } from "@/components/editor/editor-context";
import {
    attachLocalExecutorResult,
    beginLocalExecutorSession,
    isLocalExecutorSessionStop,
    localExecutorFrozenInputKey,
    localExecutorIntentAfterError,
    localExecutorIntentAfterSubmit,
    nextLocalExecutorClientOperationId,
    runOwnedTimelineRender,
    type LocalExecutorIntentState,
} from "@/lib/plugins/builtin/editor/local-executor-session";
import { lowerCanonicalPlan, getVisibleMediaClips, type TimelineRenderPlan, type TimelineRenderSource } from "@/lib/timeline/timeline-to-ffmpeg";
import { exportTimelineToMp4, type TimelineExportProgress } from "@/lib/timeline/timeline-export";
import { resourceFileUrl } from "@/services/api/resources";
import { compileTimelineRenderPlan, type TimelineRenderResult } from "@/services/api/timeline-tasks";
import { isIgnorablePlanPreviewError, RENDER_PLAN_PREVIEW_DEBOUNCE_MS } from "@/lib/timeline/timeline-plan-preview";
import { captureUserScope } from "@/lib/user-scope-guard";
import type { TimelineProject } from "@/types/timeline";

type ExportState = {
    phase: "idle" | "running" | "done" | "error";
    mode: "remote" | "local" | null;
    percent: number;
    detail: string;
    result: TimelineRenderResult | null;
};

/** 从时间线 clip 收集渲染源（按 nodeId 关联；directMedia 提供本地媒体定位）。含静音音轨与图片。 */
function collectRenderSources(project: TimelineProject): TimelineRenderSource[] {
    const seen = new Set<string>();
    const sources: TimelineRenderSource[] = [];
    for (const clip of getVisibleMediaClips(project)) {
        const direct = clip.directMedia;
        if (!direct) continue;
        if (seen.has(clip.nodeId)) continue;
        seen.add(clip.nodeId);
        sources.push({
            nodeId: clip.nodeId,
            fileName: `input-${sources.length}.mp4`,
            durationMs: clip.sourceDurationMs || clip.durationMs,
            storageKey: direct.storageKey,
            url: direct.url || direct.dataUrl || direct.content,
        });
    }
    return sources;
}

const IDLE_EXPORT_STATE: ExportState = { phase: "idle", mode: null, percent: 0, detail: "", result: null };

export function EditorExport() {
    const { project } = useEditorStoreContext();
    const { projectId } = useEditorHostContext();
    const [state, setState] = useState<ExportState>(IDLE_EXPORT_STATE);
    const runningRef = useRef(false);
    const mountedRef = useRef(true);
    const projectIdRef = useRef(projectId);
    const localControllerRef = useRef<AbortController | null>(null);
    const remoteObservationRef = useRef<AbortController | null>(null);
    const submitIntentRef = useRef<LocalExecutorIntentState | null>(null);
    projectIdRef.current = projectId;
    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            localControllerRef.current?.abort();
            remoteObservationRef.current?.abort();
        };
    }, []);
    useEffect(() => () => remoteObservationRef.current?.abort(), [projectId]);

    const sources = useMemo(() => (project ? collectRenderSources(project) : []), [project]);
    const [preview, setPreview] = useState<{ plan: TimelineRenderPlan | null; planError: string; loading: boolean }>({
        plan: null,
        planError: "",
        loading: false,
    });
    useEffect(() => {
        if (!project) {
            setPreview({ plan: null, planError: "", loading: false });
            return;
        }
        const controller = new AbortController();
        setPreview((current) => ({ ...current, loading: true, planError: "" }));
        const timer = window.setTimeout(() => {
            compileTimelineRenderPlan({
                timeline: project,
                sources: sources.map((source) => ({ id: source.nodeId, durationMs: source.durationMs })),
            }, controller.signal)
                .then((canonical) => {
                    if (controller.signal.aborted) return;
                    setPreview({ plan: lowerCanonicalPlan(canonical, sources), planError: "", loading: false });
                })
                .catch((error: unknown) => {
                    if (isIgnorablePlanPreviewError(error, controller.signal)) {
                        if (!controller.signal.aborted) setPreview((current) => ({ ...current, loading: false }));
                        return;
                    }
                    setPreview({
                        plan: null,
                        planError: error instanceof Error ? error.message : "无法生成导出计划",
                        loading: false,
                    });
                });
        }, RENDER_PLAN_PREVIEW_DEBOUNCE_MS);
        return () => {
            window.clearTimeout(timer);
            controller.abort();
        };
    }, [project, sources]);
    const plan = preview.plan;
    const planError = preview.planError;

    // 主路径：提交后端渲染任务并轮询（服务端任务上限 60 分钟，前端多留余量）。
    const renderRemote = async () => {
        if (!project || sources.length === 0 || runningRef.current) return;
        runningRef.current = true;
        const expectedScope = captureUserScope();
        const originalProjectId = projectId;
        const originalTimeline = project;
        const observer = new AbortController();
        remoteObservationRef.current?.abort();
        remoteObservationRef.current = observer;
        const frozenInputKey = localExecutorFrozenInputKey(["timeline_render", originalProjectId, originalTimeline]);
        const clientOperationId = nextLocalExecutorClientOperationId(submitIntentRef.current, frozenInputKey);
        submitIntentRef.current = { clientOperationId, frozenInputKey };
        setState({ phase: "running", mode: "remote", percent: 0, detail: "提交渲染任务…", result: null });
        try {
            const session = beginLocalExecutorSession(originalProjectId, {
                controller: observer,
                getLiveProjectId: () => projectIdRef.current,
                expectedScope,
            });
            const { task, result } = await runOwnedTimelineRender({
                session,
                projectId: originalProjectId,
                timeline: originalTimeline,
                clientOperationId,
                onCreated: (created) => {
                    submitIntentRef.current = localExecutorIntentAfterSubmit(clientOperationId, created, submitIntentRef.current ?? { clientOperationId, frozenInputKey });
                },
                onTaskUpdate: (next) =>
                    setState({
                        phase: "running",
                        mode: "remote",
                        percent: next.progress ?? 0,
                        detail: next.stage
                            ? `${next.stage}${next.progress ? ` · ${next.progress}%` : ""}`
                            : "渲染中…",
                        result: null,
                    }),
            });
            submitIntentRef.current = localExecutorIntentAfterSubmit(clientOperationId, task, submitIntentRef.current ?? { clientOperationId, frozenInputKey });
            await attachLocalExecutorResult(session, () => {
                setState({
                    phase: "done",
                    mode: "remote",
                    percent: 100,
                    detail: `渲染完成：${result.fileName ?? "timeline.mp4"}`,
                    result,
                });
            });
        } catch (error) {
            if (isLocalExecutorSessionStop(error)) {
                if (mountedRef.current) setState(IDLE_EXPORT_STATE);
                return;
            }
            submitIntentRef.current = localExecutorIntentAfterError(submitIntentRef.current ?? { clientOperationId, frozenInputKey }, error);
            setState({
                phase: "error",
                mode: "remote",
                percent: 0,
                detail: error instanceof Error ? error.message : "渲染失败",
                result: null,
            });
        } finally { runningRef.current = false; }
    };

    // 降级路径：ffmpeg.wasm 浏览器本地合成（无后端/离线时可用）。
    const exportLocalMp4 = async () => {
        if (!project || sources.length === 0 || runningRef.current) return;
        runningRef.current = true;
        const controller = new AbortController();
        localControllerRef.current = controller;
        setState({ phase: "running", mode: "local", percent: 0, detail: "准备导出", result: null });
        try {
            const blob = await exportTimelineToMp4(project, sources, {
                signal: controller.signal,
                onProgress: (p: TimelineExportProgress) =>
                    setState({ phase: "running", mode: "local", percent: p.percent, detail: p.detail, result: null }),
            });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = "timeline-export.mp4";
            a.click();
            URL.revokeObjectURL(url);
            setState({ phase: "done", mode: "local", percent: 100, detail: "导出完成，已开始下载", result: null });
        } catch (error) {
            setState({
                phase: "error",
                mode: "local",
                percent: 0,
                detail: error instanceof Error ? error.message : "导出失败",
                result: null,
            });
        } finally { runningRef.current = false; localControllerRef.current = null; }
    };

    if (!project) return null;

    return (
        <div className="flex h-full flex-col bg-[var(--director-sequencer-surface)]">
            <div className="director-scroll min-h-0 flex-1 overflow-y-auto p-3">
                <div className="mb-3 rounded-md border border-[var(--director-sequencer-border)] bg-[var(--director-control-hover)] p-2.5">
                    <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-[var(--director-dock-fg-strong)]">渲染计划</span>
                        <span className="text-[10px] text-[var(--director-dock-fg)]/60">{plan ? `${plan.steps.length} 步` : "—"}</span>
                    </div>
                    {plan && plan.steps.length > 0 ? (
                        <ul className="mt-2 space-y-1">
                            {plan.steps.slice(0, 8).map((step, index) => (
                                <li key={index} className="flex items-center gap-2 text-[11px] text-[var(--director-dock-fg)]/70">
                                    <span className="shrink-0 rounded bg-[var(--director-dock-active-surface)] px-1 py-0.5 font-mono text-[9px] uppercase text-[var(--director-dock-fg)]/80">
                                        {step.kind}
                                    </span>
                                    <span className="truncate">{step.description}</span>
                                </li>
                            ))}
                            {plan.steps.length > 8 && (
                                <li className="pt-0.5 text-[10px] text-[var(--director-dock-fg)]/50">…共 {plan.steps.length} 步</li>
                            )}
                        </ul>
                    ) : (
                        <p className="mt-2 text-[11px] text-[var(--director-dock-fg)]/55">{planError || (preview.loading ? "正在生成渲染计划" : "时间线没有可渲染的媒体片段。")}</p>
                    )}
                </div>

                <div className="mb-3 flex items-center justify-between rounded-md border border-[var(--director-sequencer-border)] bg-[var(--director-control-hover)] px-2.5 py-2 text-[11px] text-[var(--director-dock-fg)]/70">
                    <span className="flex items-center gap-1.5">
                        <PackageOpen className="size-3.5 text-[var(--director-dock-fg)]/60" />
                        渲染源
                    </span>
                    <span className="tabular-nums text-[var(--director-dock-fg)]/80">{sources.length} 个</span>
                </div>

                <button
                    type="button"
                    onClick={renderRemote}
                    disabled={sources.length === 0 || state.phase === "running"}
                    className="flex w-full items-center justify-center gap-2 rounded-md bg-[var(--director-accent)] px-2 py-1.5 text-xs font-medium text-[var(--director-on-accent)] hover:bg-[var(--director-accent-hover)] disabled:opacity-40"
                >
                    {state.phase === "running" && state.mode === "remote" ? (
                        <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                        <Server className="size-3.5" />
                    )}
                    {state.phase === "running" && state.mode === "remote" ? "渲染中…" : "渲染成片（服务端）"}
                </button>

                <button
                    type="button"
                    onClick={exportLocalMp4}
                    disabled={sources.length === 0 || Boolean(planError) || state.phase === "running"}
                    className="mt-1.5 flex w-full items-center justify-center gap-2 rounded-md border border-[var(--director-sequencer-border)] px-2 py-1.5 text-xs text-[var(--director-dock-fg)]/80 hover:bg-[var(--director-control-hover)] disabled:opacity-40"
                >
                    {state.phase === "running" && state.mode === "local" ? (
                        <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                        <Download className="size-3.5" />
                    )}
                    {state.phase === "running" && state.mode === "local" ? "导出中…" : "本地导出（ffmpeg.wasm）"}
                </button>

                {state.phase === "running" && (
                    <div className="mt-3">
                        {state.mode === "local" && <button type="button" onClick={() => localControllerRef.current?.abort()}>取消导出</button>}
                        <div className="mb-1 flex justify-between text-[10px] text-[var(--director-dock-fg)]/70">
                            <span>{state.detail}</span>
                            <span className="tabular-nums">{state.percent}%</span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-[var(--director-control-hover)]">
                            <div
                                className="h-full rounded-full bg-[var(--director-accent)] transition-all"
                                style={{ width: `${state.percent}%` }}
                            />
                        </div>
                    </div>
                )}

                {state.phase === "done" && state.result && state.mode === "remote" && (
                    <div className="mt-2 overflow-hidden rounded-md border border-[var(--director-sequencer-border)] bg-[var(--director-control-hover)]">
                        <video src={resourceFileUrl(state.result.resourceId)} controls className="aspect-video w-full bg-black" />
                        <div className="flex items-center justify-between gap-2 px-2 py-1.5 text-[11px] text-[var(--director-dock-fg)]/80">
                            <span className="truncate">{state.result.fileName ?? "timeline.mp4"}</span>
                            <a
                                href={resourceFileUrl(state.result.resourceId)}
                                download={state.result.fileName ?? "timeline.mp4"}
                                className="flex shrink-0 items-center gap-1 text-[var(--director-accent)] hover:underline"
                            >
                                <Download className="size-3" />
                                下载
                            </a>
                        </div>
                    </div>
                )}
                {state.phase === "done" && (!state.result || state.mode !== "remote") && (
                    <p className="mt-2 text-[11px] text-[var(--director-success)]">{state.detail}</p>
                )}
                {state.phase === "error" && <p className="mt-2 text-[11px] text-[var(--director-danger)]">{state.detail}</p>}

                <p className="mt-3 text-[11px] leading-relaxed text-[var(--director-dock-fg)]/55">
                    默认提交服务端渲染任务（异步，产物可直接预览/下载）；本地 ffmpeg.wasm 导出保留为离线兜底。
                </p>
                {sources.length === 0 && (
                    <p className="mt-1 text-[11px] text-[var(--director-dock-fg)]/55">请补齐缺失媒体后再导出完整成片。</p>
                )}
            </div>
        </div>
    );
}
