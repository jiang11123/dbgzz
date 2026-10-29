import { normalizeAssetCategory } from "@/lib/asset-category";
import { readImageMeta } from "@/lib/image-utils";
import { assertUserScope, isUserScopeAbandonedError, userScopeMatches, type CapturedUserScope } from "@/lib/user-scope-guard";
import { uploadImage } from "@/services/image-storage";
import { uploadMediaFile } from "@/services/file-storage";
import { persistWorkspaceAssetChanges } from "@/services/workspace-asset-repository";
import { useAssetStore } from "@/stores/use-asset-store";
import { startOperation } from "@/stores/use-operation-progress";

/** A picker submission owns its batch until settlement, independently of React views. */
export async function uploadWorkspaceAssetFiles(files: File[], folderId: string, expected: CapturedUserScope) {
    assertUserScope(expected);
    const media = files.filter((file) => file.type.startsWith("image/") || file.type.startsWith("video/"));
    if (!media.length) throw new Error("请选择图片或视频文件");
    let cursor = 0;
    let completed = 0;
    let failed = 0;
    const progress = startOperation("添加素材", { owner: expected, totalFiles: media.length, detail: "正在读取并保存素材" });
    const worker = async () => {
        while (cursor < media.length) {
            if (!userScopeMatches(expected)) return;
            const file = media[cursor++];
            try {
                const common = { title: file.name.replace(/\.[^.]+$/, ""), category: folderId.startsWith("builtin:") ? normalizeAssetCategory(folderId.slice(8)) : "material" as const, folderId: folderId.startsWith("builtin:") ? undefined : folderId || undefined, tags: [], source: "批量上传", metadata: { source: "manual-batch" } };
                if (file.type.startsWith("video/")) {
                    const uploaded = await uploadMediaFile(file, "video", undefined, expected);
                    assertUserScope(expected);
                    useAssetStore.getState().addAsset({ ...common, kind: "video", coverUrl: uploaded.preview?.url || "", data: { url: uploaded.url, storageKey: uploaded.storageKey, width: uploaded.width || 0, height: uploaded.height || 0, durationMs: uploaded.durationMs, hasAudio: uploaded.hasAudio, bytes: uploaded.bytes, mimeType: uploaded.mimeType } });
                } else {
                    const uploaded = await uploadImage(file, undefined, expected);
                    assertUserScope(expected);
                    const meta = await readImageMeta(uploaded.url).catch(() => ({ width: uploaded.width, height: uploaded.height }));
                    assertUserScope(expected);
                    useAssetStore.getState().addAsset({ ...common, kind: "image", coverUrl: uploaded.url, data: { dataUrl: uploaded.url, storageKey: uploaded.storageKey, width: meta.width || uploaded.width, height: meta.height || uploaded.height, bytes: uploaded.bytes, mimeType: uploaded.mimeType } });
                }
                completed += 1;
            } catch (error) {
                if (isUserScopeAbandonedError(error) || !userScopeMatches(expected)) return;
                failed += 1;
            }
            progress.update({ completedFiles: completed + failed, detail: "已处理 " + (completed + failed) + " 个素材" });
        }
    };
    try {
    await Promise.all(Array.from({ length: Math.min(4, media.length) }, worker));
    assertUserScope(expected);
    progress.update({ phase: "processing", detail: "正在保存素材记录" });
    let persistenceError: unknown;
    try {
        await persistWorkspaceAssetChanges(expected);
    } catch (error) {
        assertUserScope(expected);
        persistenceError = error;
    }
    assertUserScope(expected);
    if (failed || persistenceError) progress.fail("已添加 " + completed + " 个，" + (failed ? failed + " 个未完成" : "素材记录待重试"));
    else progress.done("已添加 " + completed + " 个素材");
    return { completed, failed, persistenceError };
    } catch (error) { progress.dismiss(); throw error; }
}
