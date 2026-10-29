import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("asset library category sidebar", () => {
    test("keeps type, business and folder filters in the product asset workspace", () => {
        const page = readFileSync(resolve(import.meta.dir, "../src/pages/assets/index.tsx"), "utf8");
        const css = readFileSync(resolve(import.meta.dir, "../src/styles/workspace-product.css"), "utf8");
        expect(page).toContain("assets-collection-layout");
        expect(page).toContain('aria-label="素材分类"');
        expect(page).toContain("builtinFolderCounts");
        expect(page).toContain('aria-label="新建分类"');
        expect(page).not.toContain('title="默认标签"');
        expect(page).not.toContain('title="标签与分类"');
        expect(page).toContain('className="collection-filter-label">分类</span>');
        expect(page).toContain('"character", "environment", "prop"');
        expect(page).toContain("folders.map((folder) => (");
        expect(page).not.toContain("全部自定义分类");
        expect(css).toContain(".assets-library-source-rail");
        expect(css).toContain(".assets-library-source-rail");
    });
});

describe("asset upload entry points", () => {
    test("empty state opens the native image/video picker and uploads without an intermediate modal", () => {
        const page = readFileSync(resolve(import.meta.dir, "../src/pages/assets/index.tsx"), "utf8");
        const handler = readFileSync(resolve(import.meta.dir, "../src/services/workspace-asset-upload.ts"), "utf8");
        expect(page).toContain("<AssetsEmptyState onImport={() => assetUploadInputRef.current?.click()} />");
        expect(page).toContain('accept="image/*,video/*"');
        expect(page).toContain("await uploadWorkspaceAssetFiles(files, folderId, entryScope)");
        expect(page).toContain('label: "上传资产"');
        expect(handler).toContain("uploadMediaFile(file, \"video\"");
        expect(handler).toContain("请选择图片或视频文件");
        expect(page).not.toContain("AssetBatchUploadModal");
        expect(page).not.toContain("batchUploadOpen");
    });

    test("matches LibTV personal-library new menu", () => {
        const page = readFileSync(resolve(import.meta.dir, "../src/pages/assets/index.tsx"), "utf8");
        expect(page).toContain('label: "上传资产"');
        expect(page).toContain('label: "新建文件夹"');
        expect(page).not.toContain('label: "新建文本素材"');
    });
});

describe("project card actions", () => {
    test("project cards expose the LibTV-style overflow actions", () => {
        const page = readFileSync(resolve(import.meta.dir, "../src/pages/projects/index.tsx"), "utf8");
        expect(page).toContain('aria-label={`${row.project.name} 更多操作`}');
        expect(page).toContain('label: "打开"');
        expect(page).toContain('label: "重命名"');
        expect(page).toContain('label: "修改封面"');
        expect(page).toContain('label: "创建副本"');
        expect(page).toContain('label: "移动至文件夹"');
        expect(page).toContain("duplicateProject");
        expect(page).toContain("moveProjectToFolder");
        expect(page).toContain('label: row.project.status === "archived" ? "恢复项目" : "归档项目"');
        expect(page).toContain('label: "删除项目"');
        expect(page).toContain("updateProject");
        const canvasCard = readFileSync(resolve(import.meta.dir, "../src/components/canvas/canvas-folder-card.tsx"), "utf8");
        expect(canvasCard).toContain('label: "打开"');
        expect(canvasCard).toContain('label: "重命名"');
        expect(canvasCard).toContain('label: "移动至文件夹"');
        expect(canvasCard).toContain("<LibraryCardShell");
        expect(canvasCard).toContain('label: "创建副本"');
        expect(canvasCard).toContain('label: "修改封面"');
        expect(canvasCard).toContain("beeftv-project-cover:");
        expect(canvasCard).toContain('toDataURL("image/jpeg", 0.84)');
        expect(canvasCard).toContain("onDuplicate");
        expect(canvasCard).not.toContain("summarizePreviewNodeTypes");
        expect(canvasCard).not.toContain("canvas-collection-node-types");
        const previewCard = readFileSync(resolve(import.meta.dir, "../src/components/canvas/canvas-project-card.tsx"), "utf8");
        expect(previewCard).toContain('preload="auto"');
        expect(previewCard).toContain("projectPreviewMediaCandidates(project.nodes, preferLatestImage).find");
        expect(previewCard).toContain("<Workflow className=\"canvas-project-empty-icon\"");
        const canvasPage = readFileSync(resolve(import.meta.dir, "../src/pages/canvas/index.tsx"), "utf8");
        expect(canvasPage).toContain("<LibraryCardShell");
        expect(canvasPage).toContain("maxSize = 1280");
        expect(canvasPage).toContain('toDataURL("image/jpeg", 0.84)');
        expect(canvasPage).toContain("封面图片不能超过 12MB");
        expect(canvasPage).toContain("封面请选择图片文件");
        expect(canvasPage).toContain("onOpen={() => setFolderFilter(folder.id)}");
        expect(canvasPage).toContain('label: "更换封面"');
        expect(canvasPage).not.toContain('icon: <ImageIcon className="size-3.5" />');
        expect(canvasPage).toContain('label: "删除文件夹"');
        expect(canvasPage).not.toContain('icon: <Pencil className="size-3.5" />');
        const recycleBin = readFileSync(resolve(import.meta.dir, "../src/components/canvas/recycle-bin-dialog.tsx"), "utf8");
        expect(recycleBin).toContain("restoreProject");
        expect(recycleBin).toContain("恢复到项目列表");
        expect(recycleBin).toContain("彻底删除");
        expect(recycleBin).toContain("删除后无法恢复");
        expect(recycleBin).toContain("createPortal");
        expect(recycleBin).not.toContain("<Modal");
        expect(recycleBin).toContain('role="dialog"');
        expect(recycleBin).toContain('aria-modal="true"');
        expect(recycleBin).toContain('aria-label="全选回收站项目"');
        expect(recycleBin).toContain("setSelectedDeleted(event.target.checked ? allDeletedProjectIds : [])");
        expect(recycleBin).toContain('document.body.style.overflow = "hidden"');
        expect(recycleBin).not.toContain("Popconfirm");
        expect(recycleBin).toContain("setDeleteConfirmationOpen(true)");
        expect(recycleBin).toContain('role="alertdialog"');
        expect(recycleBin).toContain('aria-labelledby="recycle-delete-title"');
        expect(recycleBin).toContain("permanentlyDeleteProjects(selectedDeleted)");
        expect(recycleBin).toContain("setDeleteConfirmationOpen(false)");
        const styles = readFileSync(resolve(import.meta.dir, "../src/styles/workspace-product.css"), "utf8");
        expect(styles).toContain(".recycle-bin-overlay { position: fixed; inset: 0;");
        expect(styles).toContain(".recycle-bin-dialog {");
        expect(styles).toContain("display: grid;");
        expect(styles).toContain("grid-template-rows: 72px minmax(0, 1fr) 68px");
        expect(styles).toContain(".recycle-bin-viewport { height: calc(var(--recycle-card-height) * 2 + var(--recycle-row-gap)); min-height: 0; overflow-y: auto;");
        expect(styles).toContain(".recycle-bin-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr));");
        expect(styles).toContain("grid-auto-rows: var(--recycle-card-height)");
        expect(styles).toContain("height: calc(var(--recycle-card-height) * 2 + var(--recycle-row-gap))");
        expect(styles).toContain(".recycle-delete-confirm-backdrop { position: absolute; inset: 0;");
        expect(styles).toContain(".recycle-delete-confirm { width: min(360px, calc(100% - 40px));");
        expect(styles).toContain(".recycle-bin-header h2 { margin: 0; color: #f5f5f5; font-size: 22px;");
        expect(styles).toContain(".recycle-bin-select-all { display: flex; align-items: center; gap: 8px; color: rgba(255,255,255,.78); font-size: 14px;");
        expect(styles).toContain(".recycle-bin-selected-count { margin-left: 4px; color: rgba(255,255,255,.42); font-size: 12px;");
        expect(styles).toContain(".recycle-bin-card.is-selected { border-color: rgba(255,255,255,.58);");
        expect(styles).toContain("appearance: none;");
        expect(styles).toContain(".recycle-bin-checkbox input:checked, .recycle-bin-select-all input:checked");
        expect(styles).toContain(".recycle-bin-footer .ant-btn { height: 36px; min-width: 104px;");
        expect(styles).not.toContain(".recycle-bin-checkbox input, .recycle-bin-select-all input { width: 16px; height: 16px; accent-color: var(--user-accent);");
        expect(styles).not.toContain(".recycle-bin-card.is-selected { border-color: var(--user-accent)");
        expect(styles).not.toContain(".libtv-recycle-modal-wrap");
        expect(canvasCard).not.toContain("canvas-collection-rename");
        expect(styles).toContain(".canvas-collection-card:focus-within .canvas-collection-select { opacity: 1; }");
        expect(styles).not.toContain(".app-user-workspace .lib-tv-project-page .canvas-collection-select { display: none; }");
        expect(styles).toContain("top: auto; right: 8px; bottom: 24px");
        expect(styles).toContain("canvas-collection-preview");
        expect(styles).toContain(".libtv-folder-card-more { position: absolute; top: auto;");
        expect(styles).toContain(".libtv-folder-card-body { display: flex; flex-direction: column; align-items: flex-start;");
        expect(styles).toContain("gap: 2px; padding: 10px 12px;");
        expect(styles).toContain("libtv-folder-card-body { min-height: 58px; padding: 8px 40px 8px 8px;");
        const globalStyles = readFileSync(resolve(import.meta.dir, "../src/styles/globals.css"), "utf8");
        expect(globalStyles).toContain("min-height: 230.8px");
        expect(globalStyles).toContain("height: 34.8px !important");
        expect(page).toContain('label: "打开"');
    });
});

describe("asset card actions", () => {
    test("asset overflow menu supports rename, categorization, download and deletion", () => {
        const page = readFileSync(resolve(import.meta.dir, "../src/pages/assets/index.tsx"), "utf8");
        expect(page).toContain('label: "重命名"');
        expect(page).toContain('label: "移动到分类"');
        expect(page).toContain('label: "下载"');
        expect(page).toContain("永久删除");
        expect(page).not.toContain('label: "编辑标签"');
        expect(page).not.toContain('label: asset.metadata?.favorite === true ? "取消收藏" : "收藏"');
    });

    test("asset overflow trigger behaves as an isolated menu control", () => {
        const page = readFileSync(resolve(import.meta.dir, "../src/pages/assets/index.tsx"), "utf8");
        expect(page).toContain('aria-haspopup="menu"');
        expect(page).toContain('onClick={(event) => event.stopPropagation()}');
    });
});

describe("generation history card actions", () => {
    test("matches LibTV hover controls for download and permanent deletion", () => {
        const page = readFileSync(resolve(import.meta.dir, "../src/pages/assets/index.tsx"), "utf8");
        const css = readFileSync(resolve(import.meta.dir, "../src/styles/assets-reference-baseline.css"), "utf8");
        expect(page).toContain('aria-label="生成结果操作"');
        expect(page).toContain('aria-label={`下载 ${asset.title}`}');
        expect(page).toContain('aria-label={`永久删除 ${asset.title}`}');
        expect(page).toContain("setPendingDelete([asset])");
        expect(page).toContain("setPendingDelete(selectedHistoryAssets)");
        expect(page).toContain("if (!await onDelete(asset)) continue");
        expect(page).toContain("onOk={() => void confirmHistoryDelete()}");
        expect(page).not.toContain("selectedHistoryAssets.forEach(onDelete)");
        expect(page).not.toContain('aria-label={`移入回收站 ${asset.title}`}');
        expect(css).toContain(".generation-history-hover-actions");
        expect(css).toContain(".generation-history-card:hover .generation-history-hover-actions");
    });

    test("supports selecting history cards for batch actions", () => {
        const page = readFileSync(resolve(import.meta.dir, "../src/pages/assets/index.tsx"), "utf8");
        const css = readFileSync(resolve(import.meta.dir, "../src/styles/assets-reference-baseline.css"), "utf8");
        expect(page).toContain('aria-label={`选择 ${asset.title}`}');
        expect(page).toContain('aria-label="生成历史批量操作"');
        expect(page).toContain("已选择");
        expect(page).toContain("selectedHistoryIds");
        expect(css).toContain(".generation-history-select");
        expect(css).toContain(".generation-history-batch-bar");
    });
});
