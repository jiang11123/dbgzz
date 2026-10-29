import { nanoid } from "nanoid";
import localforage from "localforage";
import { parseAssetRecord } from "@/lib/asset-record";
import { readUploadImageSize } from "@/lib/canvas/canvas-file-upload";
import { probeMediaMetadata, type MediaMetadata } from "@/lib/media-metadata";
import { assertUserScope, captureUserScope, type CapturedUserScope } from "@/lib/user-scope-guard";
import { ownedResourceIdFromMediaRef, resourceFileUrl, resourceStorageKey, uploadResourceFile } from "@/services/api/resources";
import { putWorkspaceAsset } from "@/services/api/workspace-data";
import { runAssetStoreProjection, useAssetStore } from "@/stores/use-asset-store";
import { mergeWorkspaceAssetReceipt } from "@/services/workspace-asset-repository";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import type { AssistantAttachment, AssistantAttachmentPurpose, AssistantSkillSelection } from "@/services/api/agent-assistant";

export const ASSISTANT_ATTACHMENT_PURPOSES: { value: AssistantAttachmentPurpose; label: string }[] = [
    { value: "analysis", label: "仅分析" }, { value: "character", label: "人物参考" }, { value: "scene", label: "场景参考" },
    { value: "style", label: "风格参考" }, { value: "motion", label: "运镜参考" }, { value: "first-frame", label: "首帧" },
    { value: "last-frame", label: "尾帧" }, { value: "rhythm", label: "节奏参考" }, { value: "sound", label: "声音参考" },
];
export function assistantAttachmentPurposes(kind: AssistantAttachment["kind"]) {
    const allowed: Record<AssistantAttachment["kind"], AssistantAttachmentPurpose[]> = {
        image: ["analysis", "character", "scene", "style", "first-frame", "last-frame"],
        video: ["analysis", "character", "scene", "style", "motion", "rhythm"],
        audio: ["analysis", "rhythm", "sound"],
    };
    return ASSISTANT_ATTACHMENT_PURPOSES.filter(item => allowed[kind].includes(item.value));
}
export function attachmentKind(mimeType: string): AssistantAttachment["kind"] | null {
    return mimeType.startsWith("image/") ? "image" : mimeType.startsWith("video/") ? "video" : mimeType.startsWith("audio/") ? "audio" : null;
}
export function attachmentRangeError(attachment: AssistantAttachment): string | null {
    if (attachment.start === undefined && attachment.end === undefined) return null;
    const start = attachment.start ?? 0, end = attachment.end;
    if (!Number.isFinite(start) || start < 0 || end === undefined || !Number.isFinite(end) || end <= start) return "请填写有效的起止时间（秒）";
    if (attachment.durationMs && end * 1000 > attachment.durationMs + 50) return "结束时间超过素材时长";
    return null;
}
export async function uploadAssistantAttachment(file: File, expected = captureUserScope(), identity = nanoid()): Promise<AssistantAttachment> {
    const kind = attachmentKind(file.type);
    if (!kind) throw new Error("请选择图片、视频或音频文件");
    assertUserScope(expected);
    const metadata: MediaMetadata | undefined = kind === "image" ? await readUploadImageSize(file) : await probeMediaMetadata(file);
    assertUserScope(expected);
    const resource = await uploadResourceFile(file, kind, { ...metadata, fileName: file.name, idempotencyKey: `assistant:${identity}`, expectedScope: expected });
    assertUserScope(expected);
    if (!resource.id || resource.status !== "ready") throw new Error("素材文件尚未保存成功，请重试上传");
    const url = resourceFileUrl(resource.id), now = new Date().toISOString();
    const positive = (value?: number) => value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
    const durationMs = positive(resource.durationMs) ?? metadata?.durationMs;
    const asset = parseAssetRecord({ id: identity, kind, title: file.name, coverUrl: kind === "image" ? url : "", category: "material", tags: [], status: "confirmed",
        source: "创作助手", createdAt: now, updatedAt: now,
        data: { ...(kind === "image" ? { dataUrl: url } : { url }), storageKey: resourceStorageKey(resource.id),
            width: metadata?.width ?? positive(resource.width) ?? 0, height: metadata?.height ?? positive(resource.height) ?? 0,
            durationMs, bytes: resource.size || file.size, mimeType: resource.mimeType || file.type },
    });
    const receipt = await putWorkspaceAsset(identity, asset, { expectedScope: expected });
    assertUserScope(expected);
    if (receipt.asset?.id !== identity) throw new Error("素材登记没有完成，请重新读取素材库后再试");
    // This is an accepted canonical write, not a second asset or a new local draft.
    runAssetStoreProjection(() => useAssetStore.setState(state => {
        const live = state.assets.find(item => item.id === identity);
        const saved = live || parseAssetRecord({ ...asset, ...mergeWorkspaceAssetReceipt(asset, asset, receipt.asset),
            createdAt: receipt.asset.createdAt || asset.createdAt, updatedAt: receipt.asset.updatedAt || asset.updatedAt });
        return { assets: live ? state.assets : [...state.assets, saved] };
    }));
    return { resourceId: resource.id, assetId: identity, kind, name: file.name, mimeType: resource.mimeType || file.type, bytes: resource.size || file.size, durationMs, purpose: "analysis" };
}
export function attachmentFromCanvasReference(reference: CanvasResourceReference): AssistantAttachment {
    if (!["image", "video", "audio"].includes(reference.kind)) throw new Error("请选择图片、视频或音频素材");
    const resourceId = ownedResourceIdFromMediaRef(reference.storageKey, reference.mediaUrl || reference.previewUrl);
    if (!resourceId) throw new Error("这个素材还没有保存到工作区，请先保存素材");
    return { resourceId, kind: reference.kind as AssistantAttachment["kind"], name: reference.title || reference.label, mimeType: "", bytes: 0,
        purpose: "analysis", ...(reference.assetId ? { assetId: reference.assetId } : { nodeId: reference.nodeId }) };
}
const drafts = localforage.createInstance({ name: "beeftv-assistant-input", storeName: "drafts" });
const draftWrites = new Map<string, Promise<unknown>>();
export type AssistantInputDraft = { text: string; attachments: AssistantAttachment[]; skills: AssistantSkillSelection[];
    resultSelection?: { sessionId: string; nodeIds: string[] } | null };
export async function readAssistantInputDraft(canvasId: string, expected: CapturedUserScope) {
    const key = `${expected.userScope}:${canvasId}`;
    await draftWrites.get(key)?.catch(() => undefined);
    const draft = await drafts.getItem<AssistantInputDraft>(key); assertUserScope(expected); return draft;
}
export async function saveAssistantInputDraft(canvasId: string, draft: AssistantInputDraft, expected: CapturedUserScope) {
    assertUserScope(expected);
    const key = `${expected.userScope}:${canvasId}`;
    const write = (draftWrites.get(key) || Promise.resolve()).catch(() => undefined).then(async () => {
        assertUserScope(expected); await drafts.setItem(key, draft); assertUserScope(expected);
    });
    draftWrites.set(key, write);
    try { await write; } finally { if (draftWrites.get(key) === write) draftWrites.delete(key); }
}
