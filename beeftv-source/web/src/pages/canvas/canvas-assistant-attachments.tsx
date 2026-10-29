import { Button, InputNumber, Select } from "antd";
import { X } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { resourceStorageKey } from "@/services/api/resources";
import { useResourceVideoPlayback } from "@/hooks/use-resource-video-playback";
import { cacheResourceObjectUrl, peekCachedResourceObjectUrl } from "@/services/resource-blob-cache";
import { getActiveUserScope, getActiveUserScopeEpoch, subscribeUserScope } from "@/lib/user-scope";
import { captureUserScope, userScopeMatches, assertUserScope } from "@/lib/user-scope-guard";
import { ASSISTANT_ATTACHMENT_PURPOSES, assistantAttachmentPurposes, attachmentRangeError } from "@/services/assistant-attachments";
import type { AssistantAttachment } from "@/services/api/agent-assistant";

function AttachmentPreview({ attachment }: { attachment: AssistantAttachment }) {
    const accountIdentity = useSyncExternalStore(subscribeUserScope, () => JSON.stringify([getActiveUserScope(), getActiveUserScopeEpoch()]), () => "");
    const expected = useMemo(() => captureUserScope(), [accountIdentity]);
    const storageKey = resourceStorageKey(attachment.resourceId);
    const video = useResourceVideoPlayback(storageKey, "", attachment.kind === "video");
    const identity = `${accountIdentity}:${attachment.kind}:${attachment.resourceId}`;
    const [retry, setRetry] = useState(0);
    const [preview, setPreview] = useState<{ identity: string; url: string; error: boolean } | null>(null);
    useEffect(() => {
        let cancelled = false;
        setPreview(null);
        if (attachment.kind === "video") return;
        const load = async () => {
            assertUserScope(expected);
            return cacheResourceObjectUrl(storageKey);
        };
        void load().then(url => {
            if (!cancelled && userScopeMatches(expected)) setPreview({ identity, url, error: !url });
        }).catch(() => {
            if (!cancelled && userScopeMatches(expected)) setPreview({ identity, url: "", error: true });
        });
        return () => { cancelled = true; };
    }, [attachment.kind, expected, identity, retry, storageKey]);
    const current = preview?.identity === identity ? preview : null;
    const url = attachment.kind === "video" ? video.url : current?.url || peekCachedResourceObjectUrl(storageKey);
    if (current?.error || video.error) return <span className="canvas-assistant-meta" role="status">预览暂时无法显示<Button size="small" onClick={() => attachment.kind === "video" ? video.retry() : setRetry(value => value + 1)}>重读预览</Button></span>;
    if (!url) return <span className="canvas-assistant-meta" role="status">正在读取预览…</span>;
    const onError = () => setPreview({ identity, url: "", error: true });
    return attachment.kind === "image" ? <img src={url} alt={attachment.name} loading="lazy" onError={onError} />
        : attachment.kind === "video" ? <video src={url} aria-label={attachment.name} controls preload="metadata" onError={() => { if (!video.requestCompatible()) video.fail(); }} /> : <audio src={url} aria-label={attachment.name} controls preload="metadata" onError={onError} />;
}

export function CanvasAssistantAttachments({ attachments, onChange, onRemove }: {
    attachments: AssistantAttachment[];
    onChange?: (index: number, attachment: AssistantAttachment) => void;
    onRemove?: (index: number) => void;
}) {
    return <div className="canvas-assistant-attachments">{attachments.map((attachment, index) => {
        const error = attachmentRangeError(attachment);
        return <div className="canvas-assistant-attachment" key={`${attachment.resourceId}:${index}`}>
            <div className="canvas-assistant-attachment-heading"><span title={attachment.name}>{attachment.name}</span>
                {onRemove ? <Button type="text" size="small" aria-label={`移除 ${attachment.name}`} icon={<X size={14} />} onClick={() => onRemove(index)} /> : null}</div>
            <AttachmentPreview attachment={attachment} />
            <span className="canvas-assistant-meta">{attachment.bytes > 0 ? `${(attachment.bytes / 1024).toFixed(0)} KB` : "已保存素材"}{attachment.durationMs ? ` · ${(attachment.durationMs / 1000).toFixed(1)} 秒` : ""}</span>
            {onChange ? <Select size="small" aria-label={`${attachment.name} 的用途`} value={attachment.purpose} options={assistantAttachmentPurposes(attachment.kind)}
                labelRender={({ value }) => ASSISTANT_ATTACHMENT_PURPOSES.find(item => item.value === value)?.label || value}
                onChange={purpose => onChange(index, { ...attachment, purpose })} /> : <span className="canvas-assistant-meta">{ASSISTANT_ATTACHMENT_PURPOSES.find(item => item.value === attachment.purpose)?.label || "仅分析"}</span>}
            {attachment.kind !== "image" && onChange ? <div className="canvas-assistant-attachment-range">
                <InputNumber size="small" min={0} changeOnBlur={false} aria-label={`${attachment.name} 起始秒`} placeholder="起始秒" value={attachment.start} onChange={start => onChange(index, { ...attachment, start: start ?? undefined })} />
                <span>—</span><InputNumber size="small" min={0} changeOnBlur={false} aria-label={`${attachment.name} 结束秒`} placeholder="结束秒" value={attachment.end} onChange={end => onChange(index, { ...attachment, end: end ?? undefined })} />
            </div> : attachment.start !== undefined || attachment.end !== undefined ? <span className="canvas-assistant-meta">{attachment.start ?? 0} — {attachment.end} 秒</span> : null}
            {error ? <span className="canvas-assistant-meta" role="status">{error}</span> : null}
        </div>;
    })}</div>;
}
