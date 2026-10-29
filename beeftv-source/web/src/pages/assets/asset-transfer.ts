import { createZip, readZip } from "@/lib/zip";
import { saveOwnedOrBrowserBlob, type OwnedMediaSaveResult } from "@/services/desktop-media-save";
import { getMediaBlob, setMediaBlob } from "@/services/file-storage";
import { getImageBlob, setImageBlob } from "@/services/image-storage";
import type { Asset } from "@/stores/use-asset-store";
import { normalizeLocalAsset } from "@/lib/local-workspace-migration";
import { isLocalWorkspaceMode } from "@/services/workspace-mode";
import { archiveFileExtension, assertUniqueArchiveNames, ExportIntegrityError, type MissingExportFile } from "@/lib/export-integrity";
import { startOperation } from "@/stores/use-operation-progress";

type AssetExportFile = {
    app: "infinite-canvas";
    version: 1;
    exportedAt: string;
    assets: Asset[];
    files: AssetExportItem[];
};

type AssetExportItem = {
    storageKey: string;
    path: string;
    mimeType: string;
    bytes: number;
};

export async function exportAssets(assets: Asset[]): Promise<OwnedMediaSaveResult> {
    const progress = startOperation("导出素材包", { detail: "正在读取素材文件", totalFiles: assets.length });
    let completed = 0;
    try {
    const files: AssetExportItem[] = [];
    const zipFiles: { name: string; data: BlobPart }[] = [];
    const missingFiles: MissingExportFile[] = [];
    const seenKeys = new Set<string>();

    await Promise.all(
        assets.map(async (asset) => {
            if (asset.kind !== "image" && asset.kind !== "video" && asset.kind !== "audio" && asset.kind !== "model") return;
            const storageKey = asset.data.storageKey;
            if (!storageKey) {
                missingFiles.push({ owner: asset.title || asset.id, reference: "媒体文件" });
                return;
            }
            if (seenKeys.has(storageKey)) return;
            seenKeys.add(storageKey);
            let blob: Blob | null | undefined;
            try {
                blob = asset.kind === "image" ? await getImageBlob(storageKey) : await getMediaBlob(storageKey);
            } catch {
                missingFiles.push({ owner: asset.title || asset.id, reference: `${storageKey}（读取失败）` });
                return;
            }
            if (!blob || blob.size === 0) {
                missingFiles.push({ owner: asset.title || asset.id, reference: storageKey });
                return;
            }
            const path = `files/${encodeURIComponent(storageKey)}.${archiveFileExtension(blob.type, asset.kind === "image" ? "png" : "bin")}`;
            files.push({ storageKey, path, mimeType: blob.type || asset.data.mimeType, bytes: blob.size });
            zipFiles.push({ name: path, data: blob });
            progress.update({ completedFiles: ++completed });
        }),
    );

    if (missingFiles.length) throw new ExportIntegrityError(missingFiles);
    assertUniqueArchiveNames(["assets.json", ...zipFiles.map((file) => file.name)]);
    for (const file of files) {
        if (!file.storageKey || file.path === file.storageKey) throw new Error("备份未完成：文件引用不一致，未生成备份。");
    }

    const exportedAssets = isLocalWorkspaceMode() ? assets.map(normalizeLocalAsset) : assets;
    const data: AssetExportFile = { app: "infinite-canvas", version: 1, exportedAt: new Date().toISOString(), assets: exportedAssets, files };
    progress.update({ phase: "processing", detail: "正在打包素材文件" });
    const zip = await createZip([{ name: "assets.json", data: JSON.stringify(data, null, 2) }, ...zipFiles]);
    progress.update({ detail: "压缩包已准备好，等待选择保存位置", loadedBytes: zip.size, totalBytes: zip.size });
    const result = await saveOwnedOrBrowserBlob("我的素材.zip", zip);
    if (result === "cancelled") progress.dismiss(); else progress.done("素材包已保存");
    return result;
    } catch (error) { progress.fail("素材导出未完成，请查看错误后重试"); throw error; }
}

export async function readAssetPackage(file: File, onProgress?: (completed: number, total: number) => void) {
    const zip = await readZip(file);
    const assetFile = zip.get("assets.json");
    if (!assetFile) throw new Error("missing assets.json");
    const data = JSON.parse(await assetFile.text()) as AssetExportFile;
    const missingFiles = data.files.filter((item) => !zip.get(item.path));
    if (missingFiles.length) throw new Error(`导入未完成，压缩包缺少文件：${missingFiles.map((item) => item.path).join("、")}`);
    let completed = 0;
    onProgress?.(completed, data.files.length);
    await Promise.all(
        data.files.map(async (item) => {
            const blob = zip.get(item.path);
            if (!blob) return;
            const typedBlob = blob.type ? blob : blob.slice(0, blob.size, item.mimeType);
            await (item.storageKey.startsWith("image:") ? setImageBlob(item.storageKey, typedBlob) : setMediaBlob(item.storageKey, typedBlob));
            onProgress?.(++completed, data.files.length);
        }),
    );
    return data.assets;
}
