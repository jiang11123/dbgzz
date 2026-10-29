import { Button } from "antd";
import { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { getActiveUserScope, getActiveUserScopeEpoch, subscribeUserScope } from "@/lib/user-scope";
import { assertUserScope, captureUserScope, userScopeMatches } from "@/lib/user-scope-guard";
import { queryGenerationTask, type GenerationTask } from "@/services/api/task-center";
import { getResourceBlob, getResourcePlaybackBlob, resourceStorageKey } from "@/services/api/resources";
import { downloadOwnedOrBrowserMedia, isWailsNativeShell } from "@/services/desktop-media-save";
import type { AssistantTurnOutput } from "@/services/api/agent-assistant";

const Player = lazy(() => import("@/components/video-player").then(module => ({ default: module.VideoPlayer })));

export function assistantOutputResource(task: GenerationTask | undefined): string | null {
    if (task?.status !== "succeeded" || !task.resultJson) return null;
    try {
        const result = JSON.parse(task.resultJson);
        return typeof result?.resourceId === "string" && result.resourceId.trim() ? result.resourceId.trim() : null;
    } catch { return null; }
}

export function CanvasAssistantOutputs({ outputs }: { outputs: AssistantTurnOutput[] }) {
    const videos = outputs.filter((output): output is Extract<AssistantTurnOutput, {kind:"video"}> => output.kind === "video");
    const projects = outputs.filter((output): output is Extract<AssistantTurnOutput, {kind:"project"}> => output.kind === "project");
    return <><CanvasAssistantVideoOutputs outputs={videos} />{projects.map(output => <AssistantProjectDownload key={output.resourceId} output={output} />)}</>;
}

function AssistantProjectDownload({output}: {output: Extract<AssistantTurnOutput,{kind:"project"}>}) {
    const [feedback,setFeedback] = useState("");
    const [loading,setLoading] = useState(false);
    async function download() {
        const scope = captureUserScope(); let url = "";
        setLoading(true);setFeedback("");
        try {
            if (!isWailsNativeShell()) {
                const blob = await getResourceBlob(resourceStorageKey(output.resourceId)); assertUserScope(scope);
                if (!blob) throw Error("missing project"); url=URL.createObjectURL(blob);
            }
            const result = await downloadOwnedOrBrowserMedia({fileName:output.fileName,resourceId:output.resourceId,browserUrl:url || undefined});
            assertUserScope(scope);if(result === "saved")setFeedback("工程已保存，可在 BeefTV 导入后继续编辑");
        } catch { if(userScopeMatches(scope))setFeedback("工程下载未完成，请重试"); }
        finally { setLoading(false);if(url)setTimeout(()=>URL.revokeObjectURL(url),1000); }
    }
    return <div className="canvas-assistant-card"><strong>可编辑工程</strong><span>{output.fileName}</span><div className="canvas-assistant-card-actions"><Button size="small" loading={loading} onClick={()=>void download()}>下载工程</Button></div>{feedback?<span role="status">{feedback}</span>:null}</div>;
}

function CanvasAssistantVideoOutputs({ outputs }: { outputs: Extract<AssistantTurnOutput,{kind:"video"}>[] }) {
    const account = useSyncExternalStore(subscribeUserScope, () => JSON.stringify([getActiveUserScope(), getActiveUserScopeEpoch()]), () => "");
    const expected = useMemo(() => captureUserScope(), [account]);
    const signature = JSON.stringify(outputs.map(output => [output.taskId, output.kind, output.sourceRevision]));
    const identity = `${account}:${signature}`;
    const currentIdentity = useRef(identity);
    currentIdentity.current = identity;
    const [records, setRecords] = useState<{ identity: string; tasks: Record<string, GenerationTask>; unread: string[] }>({ identity: "", tasks: {}, unread: [] });
    const [playback, setPlayback] = useState<{ identity: string; taskId: string; url: string; loading?: boolean; error?: boolean } | null>(null);
    const [feedback, setFeedback] = useState<{ identity: string; text: string } | null>(null);
    const ownedURLs = useRef(new Set<string>());
    const playerURL = useRef("");
    const requestSerial = useRef(0);
    const [retry, setRetry] = useState(0);
    useEffect(() => {
        let cancelled = false;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const targets = JSON.parse(signature) as [string, string, number?][];
        const read = async () => {
            const entries = await Promise.all(targets.map(async ([taskId]) => {
                try { return [taskId, await queryGenerationTask(taskId, { signal: controller.signal, expectedScope: expected })] as const; }
                catch { return [taskId, null] as const; }
            }));
            if (cancelled || !userScopeMatches(expected)) return;
            const tasks: Record<string, GenerationTask> = {}, unread: string[] = [];
            for (const [id, task] of entries) {
                if (task && task.id === id) tasks[id] = task;
                else unread.push(id);
            }
            setRecords(previous => ({ identity, tasks: { ...(previous.identity === identity ? previous.tasks : {}), ...tasks }, unread }));
            if (entries.some(([, task]) => task?.status === "queued" || task?.status === "running")) timer = setTimeout(() => void read(), 2000);
        };
        void read();
        return () => { cancelled = true; controller.abort(); if (timer) clearTimeout(timer); };
    }, [identity, signature, expected, retry]);
    useEffect(() => {
        const urls = ownedURLs.current;
        return () => { requestSerial.current++; for (const url of urls) URL.revokeObjectURL(url); urls.clear(); playerURL.current = ""; };
    }, [identity]);
    const tasks = records.identity === identity ? records.tasks : {};
    const shownPlayback = playback?.identity === identity ? playback : null;
    const last = outputs.at(-1);
    const lastReady = last && assistantOutputResource(tasks[last.taskId]);
    const lastTask = last ? tasks[last.taskId] : undefined;
    const lastUnread = Boolean(last && records.identity === identity && records.unread.includes(last.taskId));
    const previousNotice = lastUnread || !lastTask ? "这是之前已完成的版本；后一次合成结果尚未确认。"
        : lastTask.status === "queued" || lastTask.status === "running" ? "这是之前已完成的版本；后一次正在合成。"
        : lastTask.status === "failed" || lastTask.status === "cancelled" ? "这是之前已完成的版本；后一次合成未完成。"
        : lastTask.status === "succeeded" ? "这是之前已完成的版本；后一次成片暂不可用。" : "这是之前已完成的版本；后一次合成结果尚未确认。";
    async function play(taskId: string) {
        const resourceId = assistantOutputResource(tasks[taskId]);
        if (!resourceId) return;
        const serial = ++requestSerial.current;
        setPlayback({ identity, taskId, url: "", loading: true });
        try {
            assertUserScope(expected);
            const blob = await getResourcePlaybackBlob(resourceStorageKey(resourceId));
            assertUserScope(expected);
            if (serial !== requestSerial.current || currentIdentity.current !== identity) return;
            if (!blob) throw Error("missing media");
            const url = URL.createObjectURL(blob);
            if (playerURL.current) { URL.revokeObjectURL(playerURL.current); ownedURLs.current.delete(playerURL.current); }
            playerURL.current = url; ownedURLs.current.add(url);
            setPlayback({ identity, taskId, url });
        } catch {
            if (serial === requestSerial.current && currentIdentity.current === identity && userScopeMatches(expected)) setPlayback({ identity, taskId, url: "", error: true });
        }
    }
    async function download(taskId: string, title: string) {
        const resourceId = assistantOutputResource(tasks[taskId]);
        if (!resourceId) return;
        const serial = requestSerial.current;
        let url = "";
        try {
            assertUserScope(expected);
            if (!isWailsNativeShell()) {
                const blob = await getResourceBlob(resourceStorageKey(resourceId));
                assertUserScope(expected);
                if (serial !== requestSerial.current || currentIdentity.current !== identity) return;
                if (!blob) throw Error("missing media");
                url = URL.createObjectURL(blob);
                ownedURLs.current.add(url);
            }
            const result = await downloadOwnedOrBrowserMedia({ fileName: `${title}.mp4`, resourceId, browserUrl: url || undefined });
            if (result === "saved" && currentIdentity.current === identity && userScopeMatches(expected)) setFeedback({ identity, text: "成片已保存" });
        } catch {
            if (currentIdentity.current === identity && userScopeMatches(expected)) setFeedback({ identity, text: "下载没有完成，请再试一次" });
        } finally {
            // The browser starts reading the clicked link asynchronously.
            // Scope/unmount cleanup can revoke earlier; otherwise let it start first.
            if (url) { const savedURL = url; setTimeout(() => { URL.revokeObjectURL(savedURL); ownedURLs.current.delete(savedURL); }, 1000); }
        }
    }
    return <div className="canvas-assistant-outputs" aria-label="成片结果">{outputs.map((output, index) => {
        const task = tasks[output.taskId], ready = Boolean(assistantOutputResource(task));
        const title = `成片${index + 1}`;
        const unread = records.identity === identity && records.unread.includes(output.taskId);
        const status = unread ? "暂时无法读取状态" : ready ? "已就绪" : !task ? "正在读取状态" : task.status === "failed" || task.status === "cancelled" ? "合成未完成" : task.status === "succeeded" ? "成片暂不可用" : task.status === "queued" || task.status === "running" ? "正在合成" : "暂时无法确认状态";
        return <div key={output.taskId} className="canvas-assistant-card">
            <strong>{title}</strong><span role="status">{status}</span>
            {ready && output.taskId !== last?.taskId ? <span className="canvas-assistant-meta">{lastReady ? "之前的版本" : previousNotice}</span> : null}
            {ready ? <div className="canvas-assistant-card-actions"><Button size="small" loading={shownPlayback?.taskId === output.taskId && shownPlayback.loading} onClick={() => void play(output.taskId)}>播放成片</Button><Button size="small" autoInsertSpace={false} onClick={() => void download(output.taskId, title)}>下载</Button></div> : null}
            {unread ? <Button size="small" onClick={() => setRetry(value => value + 1)}>重读状态</Button> : null}
            {shownPlayback?.taskId === output.taskId && shownPlayback.url ? <Suspense fallback={<span>正在读取播放器…</span>}><Player src={shownPlayback.url} title={title} mimeType="video/mp4" autoPlay compactControls className="w-full" /></Suspense> : null}
            {shownPlayback?.taskId === output.taskId && shownPlayback.error ? <span role="status">暂时无法播放，请重新读取成片。</span> : null}
        </div>;
    })}{feedback?.identity === identity ? <span role="status">{feedback.text}</span> : null}</div>;
}
