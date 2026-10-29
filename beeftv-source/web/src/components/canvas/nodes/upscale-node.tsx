import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { Button, InputNumber, Select, Segmented } from "antd";
import { Image as ImageIcon, Video, LoaderCircle } from "lucide-react";
import type { CanvasTheme } from "@/lib/canvas-theme";
import { createDefaultUpscaleSettings, deriveUpscaleBatchState } from "@/lib/canvas/canvas-upscale";
import { canRecoverUpscaleNode } from "@/lib/canvas/canvas-ai-upscale-task";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { channelHasGenerationCredential, isBuiltinBeefAPIChannel, useEffectiveConfig } from "@/stores/use-config-store";
import { ownedResourceIdFromMediaRef } from "@/services/api/resources";
import { estimateUpscale, getUpscaleCapabilities, type UpscaleCapabilities, type UpscaleEstimate, type UpscaleMode } from "@/services/api/media-upscale";
import { useCanvasNodeActions } from "../canvas-node-action-context";
import { CanvasNodeGraphContext, useUpstreamNodes } from "../canvas-node-graph-context";

const modeLabels: Partial<Record<UpscaleMode, string>> = { precision: "保真增强", generative: "细节重建" };
const batchLabels = { waiting: "等待提交", submitting: "提交中", accepted: "已提交", rejected: "提交失败", unknown: "待确认" };

export function UpscaleNodeContent({ node, theme }: { node: CanvasNodeData; theme: CanvasTheme }) {
    const actions = useCanvasNodeActions();
    const { getNode } = useContext(CanvasNodeGraphContext);
    const upstream = useUpstreamNodes(node.id);
    const inputs = upstream.filter((item, index) => (item.type === CanvasNodeType.Image || item.type === CanvasNodeType.Video) && upstream.findIndex(other => other.id === item.id) === index);
    const imageCount = inputs.filter(item => item.type === CanvasNodeType.Image).length;
    const videoCount = inputs.length - imageCount;
    const config = useEffectiveConfig();
    const officialConnected = config.channels.some(channel => channel.enabled !== false && isBuiltinBeefAPIChannel(channel) && channelHasGenerationCredential(channel));
    const savedSettings = node.metadata?.upscale || createDefaultUpscaleSettings();
    const settings = savedSettings.image.mode === "transparent"
        ? { ...savedSettings, image: { ...savedSettings.image, mode: "precision" as const, model: createDefaultUpscaleSettings().image.model } }
        : savedSettings;
    const [capabilities, setCapabilities] = useState<UpscaleCapabilities>();
    const [estimates, setEstimates] = useState<Record<string, UpscaleEstimate>>({});
    const [notice, setNotice] = useState("");
    const [estimating, setEstimating] = useState(false);
    const [busy, setBusy] = useState(false);
    const busyRef = useRef(false);
    const batch = node.metadata?.upscaleBatch;
    const batchState = deriveUpscaleBatchState(batch, (batch?.items || []).flatMap(item => { const output = getNode?.(item.outputNodeId); return output ? [output] : []; }));
    const batchButtonLabel = !batch?.items.length ? "开始批量超分"
        : batchState.running ? "继续 / 查询批次"
        : batchState.succeeded === batchState.total ? "开始新批次"
        : batch.items.some(item => item.status === "rejected" && !item.taskId) ? "重试未提交项"
        : "查询原批次";
    const channelId = officialConnected ? "beefapi" : "";
    const patch = (change: Partial<typeof settings>) => actions.updateMetadata?.(node.id, { upscale: { ...settings, channelId, ...change } });
    useEffect(() => {
        let active = true;
        void getUpscaleCapabilities().then(value => { if (active) setCapabilities(value); }).catch(cause => { if (active) setNotice(cause instanceof Error ? cause.message : "读取超分能力失败"); });
        return () => { active = false; };
    }, []);
    const inputKey = inputs.map(item => `${item.id}:${item.type}:${item.metadata?.storageKey || ""}:${item.metadata?.content || ""}`).join("|");
    const estimateKey = JSON.stringify({ channelId, settings });
    useEffect(() => {
        let active = true;
        setEstimates({});
        setNotice("");
        if (!capabilities || !channelId || !inputs.length) return;
        const timer = window.setTimeout(() => {
            setEstimating(true);
            void Promise.all(inputs.map(async input => {
                const resourceId = ownedResourceIdFromMediaRef(input.metadata?.storageKey, input.metadata?.content) || ownedResourceIdFromMediaRef(undefined, input.metadata?.previewContent);
                if (!resourceId) return null;
                const mediaType = input.type === CanvasNodeType.Video ? "video" : "image";
                const selected = settings[mediaType];
                const capability = capabilities.modes.find(item => item.mediaType === mediaType && item.mode === selected.mode);
                const model = capability?.models.includes(selected.model) ? selected.model : capability?.models[0];
                if (!capability || !model) return null;
                const value = await estimateUpscale({ resourceId, channelId, mode: selected.mode, model, scale: capability.fixedScale || settings.scale, ...(mediaType === "image" ? { outputFormat: settings.image.outputFormat || capability.outputFormats[0], enhancementStrength: settings.image.enhancementStrength } : {}) });
                return [input.id, value] as const;
            })).then(values => { if (active) setEstimates(Object.fromEntries(values.filter(value => value !== null))); }).catch(cause => { if (active) setNotice(cause instanceof Error ? cause.message : "估价暂不可用，提交前将重新校验"); }).finally(() => { if (active) setEstimating(false); });
        }, 350);
        return () => { active = false; window.clearTimeout(timer); setEstimating(false); };
        // Inputs are identified by their stable media references rather than the graph array identity.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [inputKey, estimateKey, capabilities]);
    const reservation = useMemo(() => Object.values(estimates).reduce((sum, item) => sum + item.reservation, 0), [estimates]);
    const quotedCount = Object.keys(estimates).length;
    const run = async (result?: CanvasNodeData) => {
        if (busyRef.current) return;
        busyRef.current = true; setBusy(true); setNotice("");
        try {
            if (result) await actions.recoverUpscaleResult?.(result);
            else { if (!settings.channelId && channelId) patch({ channelId }); await actions.startUpscaleBatch?.({ ...node, metadata: { ...node.metadata, upscale: { ...settings, channelId } } }); }
        } catch (cause) { setNotice(cause instanceof Error ? cause.message : "处理失败，请查看原任务状态"); }
        finally { busyRef.current = false; setBusy(false); }
    };
    const renderMediaSettings = (mediaType: "image" | "video") => {
        const selected = settings[mediaType];
        const modes = capabilities?.modes.filter(item => item.mediaType === mediaType && item.mode !== "transparent") || [];
        const capability = modes.find(item => item.mode === selected.mode);
        return <div className="space-y-3" key={mediaType}>
            <div className="text-[var(--fs-tiny)] font-medium">{mediaType === "image" ? "图片" : "视频"}</div>
            <Segmented block aria-label={`${mediaType === "image" ? "图片" : "视频"}超分模式`} value={selected.mode} options={modes.map(item => ({ label: modeLabels[item.mode], value: item.mode }))} onChange={mode => { const next = modes.find(item => item.mode === mode); patch({ [mediaType]: { ...selected, mode, model: next?.models[0] || "", ...(mediaType === "image" ? { outputFormat: next?.outputFormats[0] || "png" } : {}) } }); }} />
            {mediaType === "image" && capability?.outputFormats.length ? <Select getPopupContainer={trigger => trigger.parentElement || document.body} className="w-full" aria-label="图片输出格式" value={settings.image.outputFormat || capability.outputFormats[0]} options={capability.outputFormats.map(format => ({ label: format.toUpperCase(), value: format }))} onChange={outputFormat => patch({ image: { ...settings.image, outputFormat } })} /> : null}
            {selected.mode === "generative" ? <p style={{ color: theme.node.muted }}>细节重建可能改变纹理与面部细节。</p> : null}
        </div>;
    };
    return <div className="relative flex h-full w-full min-h-0 min-w-0 flex-col gap-3 p-3 text-[var(--fs-tiny)]" style={{ color: theme.node.text }}>
        <div className="flex min-h-0 flex-1 flex-col gap-3">
            <div className="flex items-center gap-3" style={{ color: theme.node.muted }}><ImageIcon className="size-4" /><span>{imageCount} 张图片</span><Video className="ml-2 size-4" /><span>{videoCount} 个视频</span></div>
            {!inputs.length && !batch?.items.length ? <div className="flex flex-1 items-center justify-center text-center" style={{ color: theme.node.muted }}>从左侧连接图片或视频<br />可一次处理多个素材</div> : <div className="thin-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto" data-canvas-no-drag data-canvas-no-zoom onWheel={event => event.stopPropagation()}>{[
                ...inputs.map(input => ({ id: input.id, title: input.title || "未命名素材", type: input.type, item: batch?.items.find(item => item.sourceNodeId === input.id) })),
                ...(batch?.items || []).filter(item => !inputs.some(input => input.id === item.sourceNodeId)).map(item => ({ id: item.sourceNodeId, title: item.sourceTitle, type: item.mediaType === "video" ? CanvasNodeType.Video : CanvasNodeType.Image, item })),
            ].map(row => {
                const result = row.item ? getNode?.(row.item.outputNodeId) : undefined;
                const status = result?.metadata?.taskStatus;
                const label = !row.item ? "" : status === "succeeded" && result?.metadata?.status !== "error" ? "已完成" : status === "failed" || status === "cancelled" ? "失败" : status === "running" || status === "queued" ? "处理中" : batchLabels[row.item.status];
                return <div key={row.id} className="flex min-w-0 items-center gap-2">
                    <span className="shrink-0" style={{ color: theme.node.muted }}>{row.type === CanvasNodeType.Video ? <Video className="size-4" /> : <ImageIcon className="size-4" />}</span>
                    <span className="min-w-0 flex-1 truncate" title={row.title}>{row.title}</span>
                    {label ? <span className="w-16 shrink-0 whitespace-nowrap text-right" title={row.item?.error || result?.metadata?.errorDetails} style={{ color: theme.node.muted }}>{label}</span> : null}
                    {result && canRecoverUpscaleNode(result) ? <Button className="shrink-0" size="small" type="text" disabled={busy} onClick={() => void run(result)}>取回结果</Button> : null}
                </div>;
            })}</div>}

        </div>
        <div className="absolute inset-x-0 top-full z-20 mt-3 w-full space-y-5 rounded-[var(--r-lg)] border p-4 text-[var(--fs-tiny)] shadow-lg" style={{ background: theme.node.panel, borderColor: theme.node.edge }} data-canvas-no-drag data-canvas-no-zoom onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
            <div className="flex items-center justify-between gap-3"><span>超分倍率</span><InputNumber aria-label="超分倍率" min={1} max={4} step={1} precision={0} value={settings.scale} onChange={value => patch({ scale: value || 2 })} /></div>
            {imageCount > 0 || !videoCount ? renderMediaSettings("image") : null}
            {videoCount > 0 ? renderMediaSettings("video") : null}
            {inputs.length > 0 ? <div style={{ color: theme.node.muted }}>{estimating ? <span className="inline-flex items-center gap-1"><LoaderCircle className="size-3 animate-spin" />估价中</span> : quotedCount ? `预计预留 ¥${reservation.toFixed(2)}${quotedCount < inputs.length ? "（部分素材）" : ""}` : "提交前获取费用"}</div> : null}
            {Object.keys(estimates).length ? <details><summary className="cursor-pointer" style={{ color: theme.node.muted }}>超分后的分辨率</summary><div className="mt-2 space-y-1">{inputs.map(input => { const estimate = estimates[input.id]; return estimate ? <div key={input.id} className="flex gap-2"><span className="min-w-0 flex-1 truncate">{input.title}</span><span className="shrink-0 tabular-nums">{estimate.output.width} × {estimate.output.height}</span></div> : null; })}</div></details> : null}
            <div className="space-y-3">
                <Select getPopupContainer={trigger => trigger.parentElement || document.body} className="w-full" aria-label="超分模型" placeholder="暂无可用超分模型" disabled={!officialConnected} value={channelId || undefined} options={officialConnected ? [{ label: "BeefTV超分模型", value: "beefapi" }] : []} onChange={channelId => patch({ channelId })} />
                {!officialConnected ? <p role="status" style={{ color: theme.node.muted }}>暂无可用超分模型，请连接 BeefTV 内置的官方算力。<a href="#/settings?section=channels" className="ml-1 underline">连接官方算力</a></p> : null}
            </div>
            {notice ? <p role="alert" className="break-words" style={{ color: "var(--status-error)" }}>{notice}</p> : null}
            <Button type="primary" block loading={busy} disabled={!inputs.length || !channelId || !capabilities || !actions.startUpscaleBatch} onClick={() => void run()}>{batchButtonLabel}</Button>
        </div>
    </div>;
}
