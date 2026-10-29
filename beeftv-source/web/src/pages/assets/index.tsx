import { ArrowDownUp, AudioLines, Box, Check, CheckCheck, Clapperboard, Copy, Download, FileText, FileUp, FileX2, FolderOpen, FolderPlus, History, Image as ImageIcon, LayoutGrid, List, Maximize2, MoreHorizontal, Pause, PencilLine, Play, Plus, RotateCcw, SlidersHorizontal, Trash2, Upload, Volume2, VolumeX, X, ZoomIn, ZoomOut, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Drawer, Dropdown, Form, Input, Modal, Popover, Progress, Select, Space, Tag, Typography } from "antd";
import type { MenuProps } from "antd";
import { useNavigate, useSearchParams } from "react-router";

import { CollectionGrid, PageHeader, PaginationBar, WorkspacePage } from "@/components/layout/workspace-page";
import { ExpandableSearch } from "@/components/layout/expandable-search";
import { WorkspaceErrorState, WorkspaceLoadingState, WorkspaceState } from "@/components/layout/workspace-state";
import { AssetMediaPreview } from "@/components/asset-media-preview";
import { CachedResourceImage } from "@/components/cached-resource-image";
import { AssetLibraryCard, AssetLibraryCardMedia } from "@/components/assets/asset-library-card";
import {
    assetFolderQueryKey,
    assetLibraryQueryKey,
    assetPickerQueryKey,
    expectedScopeFromQueryKey,
    keepAssetViewPlaceholder,
    mergeHistoryLibraryAssets,
    runAssetViewAction,
    shouldSuppressAssetViewError,
    useAssetViewGeneration,
} from "@/components/assets/asset-view-session";
import { Switch } from "@/components/ui/base/switch";
import { ownedResourceIdFromMediaRef } from "@/services/api/resources";
import { useResourceVideoPlayback } from "@/hooks/use-resource-video-playback";
import { downloadOwnedOrBrowserMedia, reportOwnedMediaSave } from "@/services/desktop-media-save";
import { mediaFileExtension, sanitizeDownloadFileName } from "@/lib/canvas/canvas-media-download";
import { cn } from "@/lib/utils";

import { useCopyText } from "@/hooks/use-copy-text";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { ASSET_CATEGORY_OPTIONS, assetCategoryLabel } from "@/lib/asset-category";
import { resourceStorageLabel, resourceStorageTitle } from "@/lib/canvas/resource-storage-status";
import { formatBytes, readFileAsDataUrl, readImageMeta } from "@/lib/image-utils";
import { assertUserScope, captureUserScope, userScopeMatches, type CapturedUserScope } from "@/lib/user-scope-guard";
import { uploadImage } from "@/services/image-storage";
import { resolveMediaUrl, uploadMediaFile } from "@/services/file-storage";
import { flushAssetStorePersistence, useAssetStore, type Asset, type AssetCategory, type AssetKind, type ImageAsset } from "@/stores/use-asset-store";
import { exportAssets, readAssetPackage } from "./asset-transfer";
import { startOperation } from "@/stores/use-operation-progress";
import { assetStorageUsageQueryKey } from "./asset-storage-usage";
import { loadAssetLibraryPage, localSavedRemotePendingMessage } from "@/services/local-workspace-sync";
import { isUnsavedWorkspaceAsset, isWorkspaceGeneratedHistoryAsset, usesWorkspaceAssetLibraryApi, WORKSPACE_ASSET_UNLINKED_PROJECT, workspaceAssetAllProjectsCount, workspaceAssetCountSum, workspaceAssetProjectLabel, workspaceAssetProjectOptions, workspaceAssetTraversalTotal } from "@/services/workspace-asset-read";
import { deleteWorkspaceAsset, persistWorkspaceAssetChanges, persistWorkspaceAssetLink } from "@/services/workspace-asset-repository";
import {
    assignWorkspaceAssetsFolder,
    createWorkspaceAssetFolder,
    deleteWorkspaceAssetFolder,
    listWorkspaceAssetFolders,
    renameWorkspaceAssetFolder,
    usesWorkspaceAssetFolderApi,
} from "@/services/workspace-asset-folders";
import { workspaceCapabilities } from "@/services/workspace-mode";
import { normalizeLocalAsset } from "@/lib/local-workspace-migration";
import { useUserStore } from "@/stores/use-user-store";
import type { AssetFolder } from "@/services/api/workspace-data";
import { uploadWorkspaceAssetFiles } from "@/services/workspace-asset-upload";
import "@/styles/assets-reference-baseline.css";
import "@/styles/assets-frame-lock.css";
import "@/styles/assets-final-lock.css";

type LibraryAsset = Exclude<Asset, { kind: "entity" }>;

type AssetFormValues = {
    kind: AssetKind;
    category: AssetCategory;
    folderId?: string;
    title: string;
    coverUrl: string;
    tags: string[];
    source?: string;
    note?: string;
    content?: string;
    arkAssetId?: string;
    portraitCertified?: boolean;
};

type ImageDraft = ImageAsset["data"] | null;

const kindOptions = [
    { label: "全部", value: "all" },
    { label: "文本", value: "text" },
    { label: "图片", value: "image" },
    { label: "视频", value: "video" },
    { label: "音频", value: "audio" },
];

const categoryOptions = [{ label: "全部分类", value: "all" }, ...ASSET_CATEGORY_OPTIONS];
// Bump the preference key so existing installs that persisted list view get
// the new grid-first default once, while future user choices remain sticky.
const ASSET_VIEW_MODE_KEY = "infinite-canvas:asset-view-mode:v2";
const ASSET_HISTORY_PAGE_SIZE = 40;
type GenerationHistoryKind = "all" | "image" | "video" | "audio";
type AssetFolderFilter = "all" | "uncategorized" | string;
type AssetSortOrder = "updated_desc" | "updated_asc" | "name_asc";

const assetKindIcons: Record<LibraryAsset["kind"], LucideIcon> = {
    text: FileText,
    image: ImageIcon,
    video: Clapperboard,
    audio: AudioLines,
    model: Box,
};

export default function AssetsPage() {
    const queryClient = useQueryClient();
    const generation = useAssetViewGeneration(queryClient);
    return <AssetsPageSession key={generation} />;
}

function AssetsPageSession() {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const sourceTab = searchParams.get("tab") === "history" ? "history" : "personal";
    const queryClient = useQueryClient();
    const [entryScope] = useState(() => captureUserScope());
    const copyText = useCopyText();
    const [form] = Form.useForm<AssetFormValues>();
    const coverInputRef = useRef<HTMLInputElement>(null);
    const imageInputRef = useRef<HTMLInputElement>(null);
    const assetInputRef = useRef<HTMLInputElement>(null);
    const assetUploadInputRef = useRef<HTMLInputElement>(null);
    const modelInputRef = useRef<HTMLInputElement>(null);
    const assets = useAssetStore((state) => state.assets);
    const addAsset = useAssetStore((state) => state.addAsset);

    const updateAsset = useAssetStore((state) => state.updateAsset);
    const userId = useUserStore((state) => state.user?.id || "");
    const sessionHydrated = useUserStore((state) => state.hydrated);
    const localWorkspace = workspaceCapabilities().local;
    const remoteMode = Boolean(userId) && !localWorkspace;
    const canonicalReads = usesWorkspaceAssetLibraryApi();
    const folderApi = usesWorkspaceAssetFolderApi();
    const [keyword, setKeyword] = useState("");
    const [kindFilter, setKindFilter] = useState<AssetKind | "all">("all");
    const categoryFilter = "all";
    const [folderFilter, setFolderFilter] = useState<AssetFolderFilter>("all");
    const [projectFilter, setProjectFilter] = useState("all");
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(40);
    const [historyKind, setHistoryKind] = useState<GenerationHistoryKind>("all");
    const [historyPage, setHistoryPage] = useState(1);
    const [historyAssets, setHistoryAssets] = useState<LibraryAsset[]>([]);
    const [assetViewMode, setAssetViewMode] = useState<"grid" | "list">(readAssetViewMode);
    const [filtersOpen, setFiltersOpen] = useState(false);
    const [sortOrder, setSortOrder] = useState<AssetSortOrder>("updated_desc");
    const [editingAsset, setEditingAsset] = useState<LibraryAsset | null>(null);
    const [isAssetOpen, setIsAssetOpen] = useState(false);
    const [previewAsset, setPreviewAsset] = useState<LibraryAsset | null>(null);
    const [deletingAsset, setDeletingAsset] = useState<LibraryAsset | null>(null);
    const [deletePending, setDeletePending] = useState(false);
    const deleteInFlight = useRef(false);
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
    const [folderEditor, setFolderEditor] = useState<AssetFolder | "new" | null>(null);
    const [folderName, setFolderName] = useState("");
    const [folderSaving, setFolderSaving] = useState(false);
    const [folderDeleteConfirmId, setFolderDeleteConfirmId] = useState<string | null>(null);
    const folderSaveInFlight = useRef(false);
    const skipFolderBlurSave = useRef(false);
    const [localFolders, setLocalFolders] = useState<AssetFolder[]>([]);

    useEffect(() => {
        if (!folderDeleteConfirmId) return;
        const dismiss = (event: PointerEvent) => {
            if (!(event.target instanceof Element) || !event.target.closest(".assets-folder-delete-confirm")) {
                setFolderDeleteConfirmId(null);
            }
        };
        document.addEventListener("pointerdown", dismiss);
        return () => document.removeEventListener("pointerdown", dismiss);
    }, [folderDeleteConfirmId]);

    useEffect(() => {
        const button = document.querySelector<HTMLElement>(".assets-new-button");
        if (!button) return;
        button.style.setProperty("background-color", "#fff", "important");
        button.style.setProperty("color", "#171717", "important");
        button.style.setProperty("border-color", "rgba(255,255,255,.82)", "important");
    });

    const [formKind, setFormKind] = useState<AssetKind>("text");
    const [imageDraft, setImageDraft] = useState<ImageDraft>(null);
    const [imageFile, setImageFile] = useState<File | null>(null);
    const [imageUploading, setImageUploading] = useState(false);
    const [imageUploadProgress, setImageUploadProgress] = useState<{ phase: "uploading" | "confirming"; percent?: number } | null>(null);
    const coverUrl = Form.useWatch("coverUrl", form) || "";
    const title = Form.useWatch("title", form) || "";
    const content = Form.useWatch("content", form) || "";
    const debouncedKeyword = useDebouncedValue(keyword.trim(), 250);

    const foldersQuery = useQuery({
        queryKey: assetFolderQueryKey(entryScope),
        queryFn: ({ queryKey }) => listWorkspaceAssetFolders(expectedScopeFromQueryKey(queryKey)),
        enabled: folderApi,
    });
    useEffect(() => {
        if (folderApi) return;
        const expected = entryScope;
        let active = true;
        void listWorkspaceAssetFolders(expected).then((folders) => {
            if (active && userScopeMatches(expected)) setLocalFolders(folders);
        }).catch((error) => {
            if (shouldSuppressAssetViewError(error, expected)) return;
            // Ignore malformed local folder metadata; assets remain usable as uncategorized.
        });
        return () => { active = false; };
    }, [entryScope, folderApi]);
    const folders = folderApi ? foldersQuery.data || [] : localFolders;

    const allLibraryAssets = useMemo(() => assets.filter((asset): asset is LibraryAsset => asset.kind !== "entity"), [assets]);
    const activeAssets = useMemo(() => allLibraryAssets.filter((asset) => asset.status !== "archived"), [allLibraryAssets]);
    const localGenerationHistoryCount = useMemo(() => activeAssets.filter(isWorkspaceGeneratedHistoryAsset).length, [activeAssets]);
    const validAssets = activeAssets;
    const selectedAssets = useMemo(() => validAssets.filter((asset) => selectedIds.includes(asset.id)), [selectedIds, validAssets]);
    useEffect(() => {
        if (batchDeleteOpen && !deletePending && selectedAssets.length === 0) setBatchDeleteOpen(false);
    }, [batchDeleteOpen, deletePending, selectedAssets.length]);
    const localProjectOptions = useMemo(() => {
        const names = new Set<string>();
        for (const asset of activeAssets) {
            const label = workspaceAssetProjectLabel(asset);
            if (label !== WORKSPACE_ASSET_UNLINKED_PROJECT) names.add(label);
        }
        return Array.from(names).sort((left, right) => left.localeCompare(right, "zh-CN"));
    }, [activeAssets]);
    const filteredAssets = useMemo(() => {
        const query = keyword.trim().toLowerCase();
        const recentCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
        return validAssets.filter((asset) => {
            if (projectFilter !== "all" && workspaceAssetProjectLabel(asset) !== projectFilter) return false;
            if (kindFilter !== "all" && asset.kind !== kindFilter) return false;
            if (folderFilter.startsWith("builtin:") && (asset.folderId || asset.category !== folderFilter.slice(8))) return false;
            if (folderFilter === "uncategorized" && asset.folderId) return false;
            if (folderFilter !== "all" && folderFilter !== "uncategorized" && !folderFilter.startsWith("builtin:") && asset.folderId !== folderFilter) return false;
            if (!query) return true;
            return assetSearchText(asset).includes(query);
        });
    }, [validAssets, keyword, kindFilter, categoryFilter, folderFilter, projectFilter]);

    const assetPageQuery = useQuery({
        queryKey: assetLibraryQueryKey(entryScope, page, pageSize, "library", kindFilter, categoryFilter, folderFilter, projectFilter, debouncedKeyword),
        queryFn: ({ queryKey, signal }) => loadAssetLibraryPage({
            page,
            pageSize,
            status: "active",
            kind: kindFilter === "all" ? undefined : kindFilter,
            category: folderFilter.startsWith("builtin:") ? folderFilter.slice(8) as AssetCategory : undefined,
            folderId: folderFilter !== "all" && folderFilter !== "uncategorized" && !folderFilter.startsWith("builtin:") ? folderFilter : undefined,
            uncategorized: folderFilter.startsWith("builtin:"),
            query: debouncedKeyword || undefined,
            project: projectFilter === "all" ? undefined : projectFilter,
            signal,
            expectedScope: expectedScopeFromQueryKey(queryKey),
        }),
        enabled: canonicalReads && sessionHydrated,
        placeholderData: (previousData, previousQuery) => keepAssetViewPlaceholder(previousData, previousQuery, entryScope),
    });
    // Built-in folders contain only assets without a custom folder. Category
    // facets alone also include custom-folder assets and would overcount them.
    const builtinCountsQuery = useQuery({
        queryKey: [...assetFolderQueryKey(entryScope), "builtin-folder-counts"],
        queryFn: async ({ queryKey, signal }) => {
            const expectedScope = expectedScopeFromQueryKey(queryKey);
            const counts = await Promise.all((["character", "environment", "prop"] as const).map(async category => {
                const result = await loadAssetLibraryPage({ page: 1, pageSize: 1, status: "active", category, uncategorized: true, signal, expectedScope });
                return [category, result.total] as const;
            }));
            return Object.fromEntries(counts);
        },
        enabled: canonicalReads && sessionHydrated,
    });
    const builtinFolderCounts = canonicalReads
        ? builtinCountsQuery.data || {}
        : Object.fromEntries((["character", "environment", "prop"] as const).map(category => [category, activeAssets.filter(asset => !asset.folderId && asset.category === category).length]));

    const historyQuery = useQuery({
        queryKey: assetLibraryQueryKey(entryScope, "history", historyPage, historyKind),
        queryFn: ({ queryKey, signal }) => loadAssetLibraryPage({
            page: historyPage,
            pageSize: ASSET_HISTORY_PAGE_SIZE,
            status: "active",
            generated: true,
            kind: historyKind === "all" ? undefined : historyKind,
            signal,
            expectedScope: expectedScopeFromQueryKey(queryKey),
        }),
        enabled: canonicalReads && sessionHydrated && sourceTab === "history",
        placeholderData: (previousData, previousQuery) => keepAssetViewPlaceholder(previousData, previousQuery, entryScope),
    });
    useEffect(() => {
        if (sourceTab !== "history") {
            setHistoryKind("all");
            setHistoryPage(1);
            setHistoryAssets([]);
        }
    }, [sourceTab]);
    useEffect(() => {
        if (!canonicalReads || sourceTab !== "history" || !historyQuery.data || historyQuery.isPlaceholderData) return;
        const next = (historyQuery.data.assets || []).filter((asset): asset is LibraryAsset => asset.kind !== "entity" && asset.status !== "archived");
        setHistoryAssets((current) => mergeHistoryLibraryAssets(current, next, historyPage));
    }, [canonicalReads, historyPage, historyQuery.data, historyQuery.isPlaceholderData, sourceTab]);

    const localVisibleAssets = useMemo(() => {
        const start = (page - 1) * pageSize;
        return filteredAssets.slice(start, start + pageSize);
    }, [filteredAssets, page, pageSize]);
    const remotePageAssets = useMemo(() => (assetPageQuery.data?.assets || []).filter((asset): asset is LibraryAsset => asset.kind !== "entity"), [assetPageQuery.data?.assets]);
    const remoteTotal = assetPageQuery.data?.total ?? 0;
    const remoteReady = canonicalReads && assetPageQuery.isSuccess && assetPageQuery.data !== undefined;
    const visibleAssets = useMemo(() => remoteReady ? remotePageAssets : localVisibleAssets, [remoteReady, remotePageAssets, localVisibleAssets]);
    const orderedVisibleAssets = useMemo(() => {
        const next = [...visibleAssets];
        next.sort((left, right) => {
            if (sortOrder === "name_asc") return left.title.localeCompare(right.title, "zh-CN");
            const leftTime = new Date(left.updatedAt).getTime();
            const rightTime = new Date(right.updatedAt).getTime();
            return sortOrder === "updated_asc" ? leftTime - rightTime : rightTime - leftTime;
        });
        return next;
    }, [sortOrder, visibleAssets]);
    const visibleAssetIds = useMemo(() => visibleAssets.map((asset) => asset.id), [visibleAssets]);
    const allFilteredSelected = visibleAssetIds.length > 0 && visibleAssetIds.every((id) => selectedIds.includes(id));
    const totalAssets = canonicalReads && assetPageQuery.isError ? 0 : remoteReady ? remoteTotal : filteredAssets.length;
    const hasNarrowingFilters = kindFilter !== "all" || folderFilter !== "all" || Boolean(debouncedKeyword) || projectFilter !== "all";
    const libraryEmpty = remoteReady
        ? totalAssets === 0 && visibleAssets.length === 0 && !hasNarrowingFilters
        : validAssets.length === 0 && totalAssets === 0;

    const kindCounts = useMemo(() => assetCountMap(kindOptions, remoteReady ? assetPageQuery.data?.kindCounts : undefined, activeAssets, (asset) => asset.kind), [activeAssets, assetPageQuery.data?.kindCounts, remoteReady]);
    const categoryCounts = useMemo(() => assetCountMap(categoryOptions, remoteReady ? assetPageQuery.data?.categoryCounts : undefined, activeAssets, (asset) => asset.category || "other"), [activeAssets, assetPageQuery.data?.categoryCounts, remoteReady]);
    const folderCounts = remoteReady
        ? assetPageQuery.data?.folderCounts || {}
        : Object.fromEntries([...new Set(activeAssets.map((asset) => asset.folderId).filter((id): id is string => Boolean(id)))].map((folderId) => [folderId, activeAssets.filter((asset) => asset.folderId === folderId).length]));
    const allFoldersCount = remoteReady ? workspaceAssetCountSum(folderCounts) : activeAssets.length;
    const recentCount = remoteReady ? assetPageQuery.data?.recentTotal ?? 0 : activeAssets.filter((asset) => Number.isFinite(new Date(asset.updatedAt).getTime()) && Date.now() - new Date(asset.updatedAt).getTime() <= 30 * 24 * 60 * 60 * 1000).length;
    const generationHistoryCount = remoteReady ? assetPageQuery.data?.generatedTotal ?? 0 : localGenerationHistoryCount;
    const remoteProjectCounts = remoteReady ? assetPageQuery.data?.projectCounts : undefined;
    const projectOptions = remoteProjectCounts ? workspaceAssetProjectOptions(remoteProjectCounts) : localProjectOptions;
    const allProjectsCount = remoteProjectCounts ? workspaceAssetAllProjectsCount(remoteProjectCounts) : activeAssets.length;
    const traversalTotal = remoteReady && assetPageQuery.data ? workspaceAssetTraversalTotal(assetPageQuery.data) : filteredAssets.length;

    useEffect(() => {
        const maxPage = Math.max(1, Math.ceil(traversalTotal / pageSize));
        setPage((value) => Math.min(value, maxPage));
    }, [pageSize, traversalTotal]);

    useEffect(() => {
        window.localStorage.setItem(ASSET_VIEW_MODE_KEY, assetViewMode);
    }, [assetViewMode]);

    useEffect(() => {
        const allowed = new Set(visibleAssetIds);
        if (!canonicalReads) {
            for (const asset of validAssets) allowed.add(asset.id);
        } else {
            for (const asset of assets) {
                if (isUnsavedWorkspaceAsset(asset)) allowed.add(asset.id);
            }
        }
        setSelectedIds((current) => current.filter((id) => allowed.has(id)));
    }, [assets, canonicalReads, validAssets, visibleAssetIds]);

    const folderSelectOptions = useMemo(() => [
        { label: "不指定分类", value: "" },
        ...ASSET_CATEGORY_OPTIONS.filter(item => ["character", "environment", "prop"].includes(item.value)).map(item => ({ label: item.label, value: `builtin:${item.value}` })),
        ...folders.map((folder) => ({ label: folder.name, value: folder.id })),
    ], [folders]);

    const invalidateAssetLibrary = async (expected: CapturedUserScope = entryScope) => {
        assertUserScope(expected);
        await Promise.all([
            queryClient.invalidateQueries({ queryKey: assetLibraryQueryKey(expected) }),
            queryClient.invalidateQueries({ queryKey: assetFolderQueryKey(expected) }),
        ]);
    };

    const reflectDeletedAssets = (ids: string[], expected: CapturedUserScope) => {
        assertUserScope(expected);
        const deletedIds = new Set(ids);
        queryClient.setQueriesData<Awaited<ReturnType<typeof loadAssetLibraryPage>>>(
            { queryKey: assetLibraryQueryKey(expected) },
            (current) => {
                if (!current || !Array.isArray(current.assets)) return current;
                const assets = current.assets.filter((asset) => !deletedIds.has(asset.id));
                const removed = current.assets.length - assets.length;
                if (!removed) return current;
                return { ...current, assets, total: Math.max(0, current.total - removed), canonicalTotal: Math.max(0, current.canonicalTotal - removed) };
            },
        );
        setHistoryAssets((current) => current.filter((asset) => !deletedIds.has(asset.id)));
        setSelectedIds((current) => current.filter((id) => !deletedIds.has(id)));
    };

    const refreshDeletedAssets = async (expected: CapturedUserScope) => {
        await Promise.all([
            invalidateAssetLibrary(expected),
            queryClient.invalidateQueries({ queryKey: assetPickerQueryKey(expected) }),
        ]);
    };

    const uploadFiles = async (files: File[], folderId: string) => {
        const hideLoading = message.loading("正在上传素材…", 0);
        try {
            const result = await uploadWorkspaceAssetFiles(files, folderId, entryScope);
            if (!userScopeMatches(entryScope)) return;
            if (result.persistenceError) message.warning(localSavedRemotePendingMessage("部分素材已保存在本地", result.persistenceError));
            else if (result.completed) message.success(`已上传 ${result.completed} 个素材`);
            if (result.failed) message.error(`${result.failed} 个素材上传失败`);
            await invalidateAssetLibrary(entryScope);
        } catch (error) {
            if (!shouldSuppressAssetViewError(error, entryScope)) message.error(error instanceof Error ? error.message : "上传失败");
        } finally {
            hideLoading();
        }
    };

    const saveFolder = async () => {
        const name = folderName.trim();
        if (!folderEditor || folderSaveInFlight.current) return;
        const creating = folderEditor === "new";
        if (!name) {
            if (!creating) {
                setFolderEditor(null);
                setFolderName("");
            }
            return;
        }
        if (folderEditor !== "new" && name === folderEditor.name) {
            setFolderEditor(null);
            setFolderName("");
            return;
        }
        const folderId = folderEditor === "new" ? "" : folderEditor.id;
        folderSaveInFlight.current = true;
        setFolderSaving(true);
        try {
            const saved = await runAssetViewAction(entryScope, async (scope) => {
                if (creating) await createWorkspaceAssetFolder(name, scope);
                else await renameWorkspaceAssetFolder(folderId, name, scope);
                if (!folderApi) setLocalFolders(await listWorkspaceAssetFolders(scope));
                await invalidateAssetLibrary(scope);
                return creating ? "created" : "renamed";
            });
            if (!saved) return;
            setFolderEditor(null);
            setFolderName("");
            message.success(saved === "created" ? "素材分类已创建" : "素材分类已重命名");
        } catch (error) {
            if (shouldSuppressAssetViewError(error, entryScope)) return;
            message.error(error instanceof Error ? error.message : "素材分类保存失败");
        } finally {
            folderSaveInFlight.current = false;
            if (userScopeMatches(entryScope)) setFolderSaving(false);
        }
    };

    const removeFolder = async (folder: AssetFolder) => {
        try {
            const removed = await runAssetViewAction(entryScope, async (scope) => {
                await deleteWorkspaceAssetFolder(folder.id, scope);
                if (!folderApi) setLocalFolders(await listWorkspaceAssetFolders(scope));
                await flushAssetStorePersistence(scope);
                await invalidateAssetLibrary(scope);
                return true;
            });
            if (!removed) return;
            setFolderDeleteConfirmId(null);
            if (folderFilter === folder.id) setFolderFilter("all");
            setPage(1);
            message.success(`已删除分类「${folder.name}」，其中素材已移至未分类`);
        } catch (error) {
            if (shouldSuppressAssetViewError(error, entryScope)) return;
            message.error(error instanceof Error ? error.message : "素材分类删除失败");
            throw error;
        }
    };

    const moveSelectedAssetsToFolder = async (assetIds: string[], folderId: string) => {
        if (!assetIds.length) return;
        try {
            const moved = await runAssetViewAction(entryScope, async (scope) => {
                if (folderId.startsWith("builtin:")) {
                    for (const id of assetIds) {
                        const asset = validAssets.find(item => item.id === id);
                        if (!asset) throw new Error("素材信息已变化，请刷新后重试");
                        updateAsset(id, { category: folderId.slice(8) as AssetCategory, folderId: undefined });
                        await persistWorkspaceAssetLink({ asset: { ...asset, folderId: undefined, category: folderId.slice(8) as AssetCategory } as Asset, category: folderId.slice(8) as AssetCategory, folderId: "", expectedScope: scope });
                    }
                } else { await assignWorkspaceAssetsFolder(assetIds, folderId, scope); }
                if (!folderApi) await persistWorkspaceAssetChanges(scope);
                await flushAssetStorePersistence(scope);
                const movedIds = new Set(assetIds);
                const builtin = folderId.startsWith("builtin:");
                const remainsVisible = folderFilter === "all" || folderFilter === folderId || (folderFilter === "uncategorized" && !folderId);
                queryClient.setQueryData<Awaited<ReturnType<typeof loadAssetLibraryPage>>>(assetLibraryQueryKey(scope, page, pageSize, "library", kindFilter, categoryFilter, folderFilter, projectFilter, debouncedKeyword), current => {
                    if (!current) return current;
                    const assets = current.assets.flatMap(item => !movedIds.has(item.id) ? [item] : remainsVisible ? [{ ...item, folderId: builtin ? undefined : folderId || undefined, category: builtin ? folderId.slice(8) as AssetCategory : item.category }] : []);
                    return { ...current, assets, total: Math.max(0, current.total - (current.assets.length - assets.length)) };
                });
                await invalidateAssetLibrary(scope);
                return true;
            });
            if (!moved) return;
            setSelectedIds([]);
            message.success(`已移动 ${assetIds.length} 个素材`);
        } catch (error) {
            if (shouldSuppressAssetViewError(error, entryScope)) return;
            message.error(error instanceof Error ? error.message : "移动素材失败");
        }
    };

    const openCreate = () => {
        setEditingAsset(null);
        setImageDraft(null);
        setImageFile(null);
        setImageUploading(false);
        setImageUploadProgress(null);
        setFormKind("text");
        form.setFieldsValue({ kind: "text", category: "other", folderId: folderFilter !== "all" && folderFilter !== "uncategorized" ? folderFilter : "", title: "", coverUrl: "", tags: [], source: "手动添加", note: "", content: "", arkAssetId: "", portraitCertified: false });
        setIsAssetOpen(true);
    };

    const renameAsset = async (asset: LibraryAsset, title: string) => {
        title = title.trim();
        if (!title || title === asset.title) return;
        try {
            await runAssetViewAction(entryScope, async scope => {
                updateAsset(asset.id, { title });
                await persistWorkspaceAssetLink({ asset: { ...asset, title } as Asset, expectedScope: scope });
                queryClient.setQueriesData<Awaited<ReturnType<typeof loadAssetLibraryPage>>>({ queryKey: assetLibraryQueryKey(scope) }, current => current && Array.isArray(current.assets) ? { ...current, assets: current.assets.map(item => item.id === asset.id ? { ...item, title } : item) } : current);
                await invalidateAssetLibrary(scope);
            });
        } catch (error) {
            if (!shouldSuppressAssetViewError(error, entryScope)) message.error(error instanceof Error ? error.message : "重命名失败");
            throw error;
        }
    };

    const saveAsset = async () => {
        const values = await form.validateFields();
        if (!userScopeMatches(entryScope)) return;
        let imageData = imageDraft;
        if (values.kind === "image" && imageFile) {
            setImageUploading(true);
            setImageUploadProgress({ phase: "uploading", percent: 0 });
            try {
                const image = await runAssetViewAction(entryScope, (scope) => uploadImage(imageFile, (loaded, total) => {
                    if (userScopeMatches(scope)) setImageUploadProgress(loaded >= total ? { phase: "confirming" } : { phase: "uploading", percent: Math.floor(loaded / total * 100) });
                }, scope));
                if (!image) return;
                if (!userScopeMatches(entryScope)) return;
                setImageUploadProgress({ phase: "confirming" });
                imageData = { dataUrl: image.url, storageKey: image.storageKey, width: image.width, height: image.height, bytes: image.bytes, mimeType: image.mimeType };
                setImageDraft(imageData);
                setImageFile(null);
                void queryClient.invalidateQueries({ queryKey: assetStorageUsageQueryKey });
            } catch (error) {
                if (shouldSuppressAssetViewError(error, entryScope)) return;
                message.error(error instanceof Error ? error.message : "图片上传失败，请重试");
                return;
            } finally {
                if (userScopeMatches(entryScope)) {
                    setImageUploading(false);
                    setImageUploadProgress(null);
                }
            }
        }

        const base = {
            title: values.title.trim(),
            category: values.folderId?.startsWith("builtin:") ? values.folderId.slice(8) as AssetCategory : "other" as AssetCategory,
            folderId: values.folderId?.startsWith("builtin:") ? undefined : values.folderId || undefined,
            status: editingAsset?.status || ("confirmed" as const),
            primaryVersionId: editingAsset?.primaryVersionId,
            coverUrl: values.coverUrl?.trim() || (values.kind === "image" && imageData ? imageData.dataUrl : ""),
            tags: values.tags || [],
            source: values.source?.trim(),
            note: values.note?.trim(),
            arkAssetId: values.arkAssetId?.trim() || undefined,
            portraitCertified: values.portraitCertified || undefined,
            metadata: editingAsset?.metadata || { source: "manual" },
        };

        if (values.kind !== "text" && !imageData) {
            message.error("请选择图片文件");
            return;
        }

        try {
            const saved = await runAssetViewAction(entryScope, async (scope) => {
                if (values.kind === "text") {
                    const asset = { ...base, kind: "text" as const, data: { content: (values.content || "").trim() } };
                    editingAsset ? updateAsset(editingAsset.id, asset) : addAsset(asset);
                } else {
                    const asset = { ...base, kind: "image" as const, data: imageData! };
                    editingAsset ? updateAsset(editingAsset.id, asset) : addAsset(asset);
                }
                await persistWorkspaceAssetChanges(scope);
                await invalidateAssetLibrary(scope);
                return editingAsset ? "updated" : "created";
            });
            if (!saved) return;
            message.success(saved === "updated" ? "素材已更新" : "素材已保存");
            setIsAssetOpen(false);
        } catch (error) {
            if (shouldSuppressAssetViewError(error, entryScope)) return;
            message.warning(localSavedRemotePendingMessage(editingAsset ? "素材已在本地更新" : "素材已在本地保存", error));
            setIsAssetOpen(false);
        }
    };


    const readCoverFile = async (file?: File) => {
        if (!file) return;
        const dataUrl = await readFileAsDataUrl(file);
        if (!userScopeMatches(entryScope)) return;
        form.setFieldValue("coverUrl", dataUrl);
    };

    const readImageFile = async (file?: File) => {
        if (!file || !file.type.startsWith("image/") || imageUploading) return;
        try {
            const dataUrl = await readFileAsDataUrl(file);
            const meta = await readImageMeta(dataUrl);
            if (!userScopeMatches(entryScope)) return;
            setImageFile(file);
            const draft = { dataUrl, storageKey: "", width: meta.width, height: meta.height, bytes: file.size, mimeType: file.type || meta.mimeType };
            setImageDraft(draft);
            if (!form.getFieldValue("coverUrl")) form.setFieldValue("coverUrl", dataUrl);
            if (!form.getFieldValue("title")) form.setFieldValue("title", file.name);
        } catch (error) {
            if (shouldSuppressAssetViewError(error, entryScope)) return;
            message.error(error instanceof Error ? error.message : "读取图片失败，请重试");
        }
    };

    const readModelFile = async (file?: File) => {
        if (!file || !/\.(glb|gltf)$/i.test(file.name)) return;
        try {
            const uploaded = await runAssetViewAction(entryScope, async (scope) => {
                const result = await uploadMediaFile(file, "model", undefined, scope);
                assertUserScope(scope);
                addAsset({
                    kind: "model",
                    title: file.name.replace(/\.(glb|gltf)$/i, ""),
                    coverUrl: "",
                    tags: ["3D模型"],
                    source: "手动上传",
                    data: { url: result.url, storageKey: result.storageKey, bytes: result.bytes, mimeType: result.mimeType, fileName: file.name },
                    metadata: { source: "manual" },
                });
                await persistWorkspaceAssetChanges(scope);
                void queryClient.invalidateQueries({ queryKey: assetStorageUsageQueryKey });
                await invalidateAssetLibrary(scope);
                return result;
            });
            if (!uploaded) return;
            // Hosted mode may retry the remote copy; local mode intentionally keeps
            // the browser fallback local and does not expose a cloud-upload warning.
            if (uploaded.pendingRemoteUpload) {
                // The local workspace must never surface a cloud-sync promise, even
                // if an upload result was created before the session mode finished
                // hydrating. Hosted mode keeps the retry wording.
                message.warning(localWorkspace ? "3D 模型已保存在本机" : `3D 模型已保存在本机，等待远端同步${uploaded.remoteUploadError ? `：${uploaded.remoteUploadError}` : ""}`);
            }
            else message.success("3D 模型已保存");
        } catch (error) {
            if (shouldSuppressAssetViewError(error, entryScope)) return;
            message.warning(localSavedRemotePendingMessage("3D 模型已在本地保存", error));
        }
    };

    const copyAssetText = async (asset: LibraryAsset) => {
        if (asset.kind !== "text") return;
        copyText(asset.data.content, "文本已复制");
    };

    const downloadImage = (asset: LibraryAsset) => {
        if (asset.kind !== "image" && asset.kind !== "video" && asset.kind !== "audio" && asset.kind !== "model") return;
        const url = asset.kind === "image" ? asset.data.dataUrl : asset.data.url;
        const extension = asset.kind === "model" ? asset.data.fileName.split(".").pop() || "glb" : mediaFileExtension(asset.data.mimeType, url) || "bin";
        void reportOwnedMediaSave(message, downloadOwnedOrBrowserMedia({
            fileName: sanitizeDownloadFileName(`${asset.title || "素材"}.${extension}`),
            resourceId: ownedResourceIdFromMediaRef(asset.data.storageKey, url) || undefined,
            browserUrl: url,
        }));
    };

    const exportAllAssets = async () => {
        if (!validAssets.length) {
            message.warning("暂无素材可导出");
            return;
        }
        await reportOwnedMediaSave(message, exportAssets(validAssets));
    };

    const importAssetZip = async (file?: File) => {
        if (!file) return;
        const progress = startOperation("导入素材包", { owner: entryScope, detail: "正在读取与解压素材包", totalBytes: file.size });
        try {
            const imported = await runAssetViewAction(entryScope, async (scope) => {
                const importedAssets = await readAssetPackage(file, (completedFiles, totalFiles) => progress.update({ phase: "processing", detail: "正在保存素材文件", completedFiles, totalFiles }));
                progress.update({ phase: "processing", detail: "正在保存素材记录", totalFiles: importedAssets.length, completedFiles: importedAssets.length });
                if (!userScopeMatches(scope)) return undefined;
                importedAssets.forEach((asset) => {
                    const payload = { ...asset } as Record<string, unknown>;
                    delete payload.id;
                    delete payload.createdAt;
                    delete payload.updatedAt;
                    addAsset((localWorkspace ? normalizeLocalAsset(payload) : payload) as Parameters<typeof addAsset>[0]);
                });
                await flushAssetStorePersistence(scope);
                return importedAssets.length;
            });
            if (imported == null) return;
            try {
                await persistWorkspaceAssetChanges(entryScope);
            } catch (error) {
                if (shouldSuppressAssetViewError(error, entryScope)) return;
                message.warning(localSavedRemotePendingMessage("素材已在本地导入", error));
            }
            if (!userScopeMatches(entryScope)) return;
            message.success(`已导入 ${imported} 个素材`);
            progress.done("已导入 " + imported + " 个素材");
        } catch (error) {
            if (shouldSuppressAssetViewError(error, entryScope)) progress.dismiss();
            else progress.fail("素材包导入未完成，请查看错误后重试");
            if (shouldSuppressAssetViewError(error, entryScope)) return;
            message.error("导入失败，请选择有效的素材压缩包");
        } finally {
            if (userScopeMatches(entryScope) && assetInputRef.current) assetInputRef.current.value = "";
        }
    };

    const deleteHistoryAsset = async (asset: LibraryAsset) => {
        try {
            const deleted = await runAssetViewAction(entryScope, async (scope) => {
                await deleteWorkspaceAsset(asset.id, scope);
                reflectDeletedAssets([asset.id], scope);
                await refreshDeletedAssets(scope);
                return true;
            });
            if (!deleted) return;
            return true;
        } catch (error) {
            if (shouldSuppressAssetViewError(error, entryScope)) return;
            message.error(error instanceof Error ? error.message : "素材删除失败");
            return false;
        }
    };

    const confirmDelete = async () => {
        if (!deletingAsset || deleteInFlight.current) return;
        deleteInFlight.current = true;
        setDeletePending(true);
        try {
            const deleted = await runAssetViewAction(entryScope, async (scope) => {
                await deleteWorkspaceAsset(deletingAsset.id, scope);
                reflectDeletedAssets([deletingAsset.id], scope);
                await refreshDeletedAssets(scope);
                return true;
            });
            if (!deleted) return;
            message.success("素材已彻底删除");
            setDeletingAsset(null);
        } catch (error) {
            if (shouldSuppressAssetViewError(error, entryScope)) return;
            message.error(error instanceof Error ? error.message : "素材删除失败");
        } finally {
            deleteInFlight.current = false;
            setDeletePending(false);
        }
    };

    const exportSelectedAssets = async () => {
        if (!selectedAssets.length) return;
        await reportOwnedMediaSave(message, exportAssets(selectedAssets));
    };

    const confirmBatchDelete = async () => {
        if (!selectedAssets.length || deleteInFlight.current) return;
        deleteInFlight.current = true;
        setDeletePending(true);
        const deleting = [...selectedAssets];
        const deletedIds: string[] = [];
        const failures: string[] = [];
        try {
            const completed = await runAssetViewAction(entryScope, async (scope) => {
                for (const asset of deleting) {
                    assertUserScope(scope);
                    try {
                        await deleteWorkspaceAsset(asset.id, scope);
                        deletedIds.push(asset.id);
                    } catch (error) {
                        if (shouldSuppressAssetViewError(error, scope)) throw error;
                        failures.push(`${asset.title || "未命名素材"}：${error instanceof Error ? error.message : "删除失败"}`);
                    }
                }
                if (deletedIds.length) reflectDeletedAssets(deletedIds, scope);
                return true;
            });
            if (!completed) return;
            setBatchDeleteOpen(false);
            if (failures.length) {
                message.error(`已删除 ${deletedIds.length} 个，${failures.length} 个未删除。${failures.join("；")}`);
            } else {
                message.success(`已彻底删除 ${deletedIds.length} 个素材`);
            }
            // Refresh failure must not turn completed deletions into failed commands.
            try { await refreshDeletedAssets(entryScope); }
            catch (error) {
                if (!shouldSuppressAssetViewError(error, entryScope)) message.warning("删除结果已保存，列表刷新失败，请重新打开素材库");
            }
        } catch (error) {
            if (shouldSuppressAssetViewError(error, entryScope)) return;
            message.error(error instanceof Error ? error.message : "批量删除失败");

        } finally {
            deleteInFlight.current = false;
            setDeletePending(false);
        }
    };

    if (sourceTab === "history") {
        const localHistoryAssets = activeAssets;
        const localGenerated = localHistoryAssets.filter(isWorkspaceGeneratedHistoryAsset);
        const visibleHistoryAssets = canonicalReads ? historyAssets : localHistoryAssets;
        const generatedKindCounts = canonicalReads
            ? historyQuery.data?.generatedKindCounts || {}
            : localGenerated.reduce<Record<string, number>>((counts, asset) => {
                counts[asset.kind] = (counts[asset.kind] || 0) + 1;
                return counts;
            }, {});
        const generatedTotal = canonicalReads ? historyQuery.data?.generatedTotal ?? 0 : localGenerated.length;
        if (canonicalReads && historyQuery.isError && historyPage <= 1 && !historyAssets.length) {
            return (
                <WorkspacePage grid className="library-page assets-library-page canvas-library-page generation-history-page">
                    <WorkspaceErrorState title="生成历史读取失败" description="请稍后重试。" actionLabel="重试" onRetry={() => void historyQuery.refetch()} />
                </WorkspacePage>
            );
        }
        if (canonicalReads && !historyQuery.isSuccess && historyPage <= 1 && !historyAssets.length) {
            return (
                <WorkspacePage grid className="library-page assets-library-page canvas-library-page generation-history-page">
                    <WorkspaceLoadingState label="正在读取生成历史" detail="按页读取已保存的素材。" />
                </WorkspacePage>
            );
        }
        return (
            <GenerationHistorySurface
                assets={visibleHistoryAssets}
                generatedTotal={generatedTotal}
                generatedKindCounts={generatedKindCounts}
                libraryTotal={totalAssets}
                kind={canonicalReads ? historyKind : undefined}
                hasMore={canonicalReads ? Boolean(historyQuery.data?.canonicalHasMore ?? historyQuery.data?.hasMore) : false}
                loadingMore={canonicalReads && historyQuery.isFetching}
                loadMoreError={Boolean(canonicalReads && historyQuery.isError && historyPage > 1)}
                onKindChange={canonicalReads ? (next) => {
                    setHistoryKind(next);
                    setHistoryPage(1);
                    setHistoryAssets([]);
                } : undefined}
                onLoadMore={canonicalReads ? () => {
                    if (historyQuery.isFetching) return;
                    if (historyQuery.isError) {
                        void historyQuery.refetch();
                        return;
                    }
                    if (historyQuery.isPlaceholderData) return;
                    setHistoryPage((current) => current + 1);
                } : undefined}
                onSelectPersonal={() => navigate("/assets?tab=personal")}
                onDownload={downloadImage}
                onDelete={deleteHistoryAsset}
            />
        );
    }

    return (
        <>
            <input
                ref={assetUploadInputRef}
                type="file"
                accept="image/*,video/*"
                multiple
                className="hidden"
                onChange={(event) => {
                    const files = Array.from(event.currentTarget.files || []);
                    event.currentTarget.value = "";
                    if (!files.length) return;
                    void uploadFiles(files, folderFilter !== "all" && folderFilter !== "uncategorized" ? folderFilter : "");
                }}
            />
            <WorkspacePage grid className="library-page assets-library-page canvas-library-page">
                <div className="studio-band assets-library-hero">
                    <PageHeader
                        title="个人资产库"
                        actions={
                            <div className="assets-header-actions">
                                <div className="assets-header-action-buttons">
                                    <div className="assets-header-compact-actions">
                                        <ExpandableSearch value={keyword} placeholder="搜索资产" onChange={(value) => { setPage(1); setKeyword(value); }} />
                                        <button type="button" className={cn("assets-header-compact-button", filtersOpen && "is-active")} aria-label="筛选资产" title="筛选资产" aria-pressed={filtersOpen} onClick={() => setFiltersOpen((open) => !open)}><SlidersHorizontal className="size-4" /></button>
                                    </div>
                                    <Dropdown trigger={["click"]} menu={{ items: [
                                        { key: "image", label: "上传资产", onClick: () => assetUploadInputRef.current?.click() },
                                        { key: "folder", label: "新建文件夹", onClick: () => { setFolderName(""); setFolderEditor("new"); } },
                                    ] }}>
                                        <Button className="assets-new-button" style={{ backgroundColor: "#fff", color: "#171717", borderColor: "rgba(255,255,255,.82)" }} icon={<Plus />}>新建</Button>
                                    </Dropdown>
                                </div>
                            </div>
                        }
                    />
                    <div className="assets-secondary-controls is-open">
                        <div className="assets-kind-row">
                            <nav className="assets-kind-tabs" aria-label="资产类型">
                                {kindOptions.map((option) => (
                                    <button
                                        key={option.value}
                                        type="button"
                                        className={cn("assets-kind-tab", kindFilter === option.value && "is-active")}
                                        onClick={() => {
                                            setKindFilter(option.value as AssetKind | "all");
                                            setPage(1);
                                        }}
                                    >
                                        {option.label}
                                        <span>{kindCounts.get(option.value) ?? 0}</span>
                                    </button>
                                ))}
                            </nav>
                            <div className="assets-kind-actions">
                            <div className="assets-view-toggle" role="group" aria-label="资产视图">
                                <button type="button" className={assetViewMode === "grid" ? "is-active" : ""} aria-pressed={assetViewMode === "grid"} title="网格视图" onClick={() => setAssetViewMode("grid")}><LayoutGrid className="size-3.5" /><span className="sr-only">网格视图</span></button>
                                <button type="button" className={assetViewMode === "list" ? "is-active" : ""} aria-pressed={assetViewMode === "list"} title="列表视图" onClick={() => setAssetViewMode("list")}><List className="size-3.5" /><span className="sr-only">列表视图</span></button>
                            </div>
                            <label className="assets-sort-control">
                                <Select
                                    value={sortOrder}
                                    className="w-full sm:w-32"
                                    aria-label="排序"
                                    options={[{ label: "时间倒序", value: "updated_desc" }, { label: "时间正序", value: "updated_asc" }, { label: "名称排序", value: "name_asc" }]}
                                    onChange={(value) => setSortOrder(value as AssetSortOrder)}
                                />
                            </label>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="collection-content assets-collection-content">
                    <div className={cn("assets-collection-layout", filtersOpen && "is-filters-open")}>
                        <aside className="assets-collection-filters" aria-label="素材分类" aria-hidden={!filtersOpen} inert={!filtersOpen}>
                            <div className="assets-collection-filter-scroll">
                            <section className="collection-filter-group assets-folder-filter">
                                <div className="collection-folder-heading">
                                    <span className="collection-filter-label">分类</span>
                                    <button type="button" className="assets-folder-add" title="新建分类" aria-label="新建分类" onClick={() => { setFolderName(""); setFolderEditor("new"); }}><FolderPlus className="size-3.5" /></button>
                                </div>
                                <div className="collection-folder-list">
                                    <button type="button" aria-pressed={folderFilter === "all"} className={`assets-filter-item ${folderFilter === "all" ? "is-active" : ""}`} onClick={() => { setFolderFilter("all"); setPage(1); }}>
                                        <span className="assets-filter-item-label">全部</span><span className="assets-filter-count">{allFoldersCount}</span>
                                    </button>
                                    {ASSET_CATEGORY_OPTIONS.filter(item => ["character", "environment", "prop"].includes(item.value)).map(item => (
                                        <button key={item.value} type="button" aria-pressed={folderFilter === `builtin:${item.value}`} className={`assets-filter-item ${folderFilter === `builtin:${item.value}` ? "is-active" : ""}`} onClick={() => { setFolderFilter(`builtin:${item.value}`); setPage(1); }}>
                                            <span className="assets-filter-item-label">{item.label}</span><span className="assets-filter-count">{builtinFolderCounts[item.value] ?? 0}</span>
                                        </button>
                                    ))}
                                    {folders.map((folder) => (
                                        <Dropdown
                                            key={folder.id}
                                            trigger={["contextMenu"]}
                                            disabled={folderEditor !== "new" && folderEditor?.id === folder.id}
                                            menu={{
                                                items: [
                                                    { key: "rename", label: "重命名" },
                                                    { type: "divider" },
                                                    { key: "delete", label: "删除", danger: true },
                                                ],
                                                onClick: ({ key }) => {
                                                    if (key === "rename") {
                                                        setFolderDeleteConfirmId(null);
                                                        setFolderName(folder.name);
                                                        setFolderEditor(folder);
                                                        return;
                                                    }
                                                    setFolderEditor(null);
                                                    setFolderDeleteConfirmId(folder.id);
                                                },
                                            }}
                                        >
                                            <div className="assets-folder-row">
                                                {folderEditor !== "new" && folderEditor?.id === folder.id ? (
                                                    <Input
                                                        autoFocus
                                                        size="small"
                                                        className="assets-folder-inline-input"
                                                        value={folderName}
                                                        maxLength={40}
                                                        disabled={folderSaving}
                                                        aria-label={`重命名分类 ${folder.name}`}
                                                        onChange={(event) => setFolderName(event.target.value)}
                                                        onPressEnter={() => void saveFolder()}
                                                        onBlur={() => {
                                                            if (skipFolderBlurSave.current) {
                                                                skipFolderBlurSave.current = false;
                                                                return;
                                                            }
                                                            void saveFolder();
                                                        }}
                                                        onKeyDown={(event) => {
                                                            if (event.key === "Escape") {
                                                                skipFolderBlurSave.current = true;
                                                                setFolderEditor(null);
                                                                setFolderName("");
                                                                window.setTimeout(() => { skipFolderBlurSave.current = false; }, 0);
                                                            }
                                                        }}
                                                    />
                                                ) : (
                                                    <button type="button" aria-pressed={folderFilter === folder.id} className={`assets-filter-item min-w-0 flex-1 ${folderFilter === folder.id ? "is-active" : ""}`} onClick={() => { setFolderFilter(folder.id); setPage(1); }}>
                                                        <span className="assets-filter-item-label min-w-0 truncate">{folder.name}</span><span className="assets-filter-count">{remoteReady ? folderCounts[folder.id] ?? 0 : activeAssets.filter((asset) => asset.folderId === folder.id).length}</span>
                                                    </button>
                                                )}
                                                {folderDeleteConfirmId === folder.id ? (
                                                    <div
                                                        className="assets-folder-delete-confirm"
                                                        role="alertdialog"
                                                        aria-label={`确认删除分类 ${folder.name}`}
                                                        onKeyDown={(event) => {
                                                            if (event.key === "Escape") setFolderDeleteConfirmId(null);
                                                        }}
                                                    >
                                                        <p>分类中的素材会移至未分类。</p>
                                                        <div className="assets-folder-delete-actions">
                                                            <button type="button" onClick={() => setFolderDeleteConfirmId(null)}>取消</button>
                                                            <button type="button" className="is-danger" onClick={() => { setFolderDeleteConfirmId(null); void removeFolder(folder); }}>删除分类</button>
                                                        </div>
                                                    </div>
                                                ) : null}
                                            </div>
                                        </Dropdown>
                                    ))}
                                </div>
                            </section>
                            {projectOptions.length ? (
                                <section className="collection-filter-group assets-project-filter" aria-label="项目来源">
                                    <span className="collection-filter-label">项目来源</span>
                                    <div className="collection-filter-options">
                                        <button type="button" aria-pressed={projectFilter === "all"} className={`assets-filter-item ${projectFilter === "all" ? "is-active" : ""}`} onClick={() => { setProjectFilter("all"); setPage(1); }}>
                                            <span className="assets-filter-item-label">全部项目</span><span className="assets-filter-count">{allProjectsCount}</span>
                                        </button>
                                        {projectOptions.map((project) => {
                                            const count = remoteProjectCounts ? remoteProjectCounts[project] ?? 0 : activeAssets.filter((asset) => workspaceAssetProjectLabel(asset) === project).length;
                                            return <button key={project} type="button" aria-pressed={projectFilter === project} className={`assets-filter-item ${projectFilter === project ? "is-active" : ""}`} onClick={() => { setProjectFilter(project); setPage(1); }}><span className="assets-filter-item-label truncate">{project}</span><span className="assets-filter-count">{count}</span></button>;
                                        })}
                                    </div>
                                </section>
                            ) : null}

                            </div>
                        </aside>
                        <section className="min-w-0">
                            {selectedAssets.length ? (
                                <AssetsBatchBar
                                    count={selectedAssets.length}
                                    allSelected={allFilteredSelected}
                                    onSelectAll={() => setSelectedIds((current) => Array.from(new Set([...current, ...visibleAssetIds])))}
                                    onClear={() => setSelectedIds([])}
                                    onExport={() => void exportSelectedAssets()}
                                    onDelete={() => setBatchDeleteOpen(true)}
                                    folderOptions={folderSelectOptions}
                                    onMoveToFolder={(folderId) => void moveSelectedAssetsToFolder(selectedAssets.map((asset) => asset.id), folderId)}
                                />
                            ) : null}
                            {canonicalReads && assetPageQuery.isError ? (
                                <WorkspaceErrorState compact title="素材读取失败" description="请稍后重试。" actionLabel="重试" onRetry={() => void assetPageQuery.refetch()} />
                            ) : canonicalReads && !remoteReady ? (
                                <WorkspaceLoadingState label="正在读取素材" detail="正在加载已保存的素材。" />
                            ) : libraryEmpty ? (
                                <AssetsEmptyState onImport={() => assetUploadInputRef.current?.click()} />
                            ) : (
                                <>
                                    {visibleAssets.length === 0 ? (
                                        <WorkspaceState icon="assets" compact title="没有匹配的素材" description="调整关键词或左侧分类后再试。" />
                                    ) : (
                                        <CollectionGrid className={cn("library-grid", "assets-library-grid", assetViewMode === "list" && "is-list-view")}>
                                            {orderedVisibleAssets.map((asset) => (
                                                <AssetCard
                                                    key={asset.id}
                                                    asset={asset}
                                                    selected={selectedIds.includes(asset.id)}
                                                    deleting={deletingAsset?.id === asset.id}
                                                    deletePending={deletePending}
                                                    onSelect={(selected) => setSelectedIds((current) => (selected ? [...new Set([...current, asset.id])] : current.filter((id) => id !== asset.id)))}
                                                    onOpen={() => setPreviewAsset(asset)}
                                                    onRename={(title) => renameAsset(asset, title)}
                                                    onCopy={copyAssetText}
                                                    onDownload={downloadImage}
                                                    onDelete={() => setDeletingAsset(asset)}
                                                    onConfirmDelete={confirmDelete}
                                                    onCancelDelete={() => setDeletingAsset(null)}
                                                    folderOptions={folderSelectOptions}
                                                    onMoveToFolder={(folderId) => void moveSelectedAssetsToFolder([asset.id], folderId)}
                                                />
                                            ))}
                                        </CollectionGrid>
                                    )}
                                    <PaginationBar
                                        current={page}
                                        pageSize={pageSize}
                                        total={traversalTotal}
                                        pageSizeOptions={[40, 80, 120]}
                                        onChange={(nextPage, nextPageSize) => {
                                            setPage(nextPageSize !== pageSize ? 1 : nextPage);
                                            setPageSize(nextPageSize);
                                        }}
                                    />
                                </>
                            )}
                        </section>
                    </div>
                </div>
                <aside className="assets-library-source-rail" aria-label="资产来源导航">
                    <div className="assets-library-source-rail-inner">
                        <button type="button" className="assets-library-source-rail-item" onClick={() => navigate("/assets?tab=history")}>
                            <span className="assets-library-source-rail-icon"><History className="size-3.5" /></span>
                            <span>生成历史</span>
                            <span className="assets-filter-count">{generationHistoryCount}</span>
                        </button>
                        <button type="button" className="assets-library-source-rail-item is-active" aria-current="page">
                            <span className="assets-library-source-rail-icon"><FolderOpen className="size-3.5" /></span>
                            <span>个人资产库</span>
                            <span className="assets-filter-count">{totalAssets}</span>
                        </button>
                    </div>
                </aside>
            </WorkspacePage>

            <Modal
                className="workspace-modal workspace-modal-wide library-modal"
                title={editingAsset ? "编辑素材" : "新增素材"}
                open={isAssetOpen}
                onCancel={() => {
                    if (!imageUploading) setIsAssetOpen(false);
                }}
                onOk={() => void saveAsset()}
                okText={imageUploading ? "正在上传" : "保存"}
                cancelText="取消"
                confirmLoading={imageUploading}
                cancelButtonProps={{ disabled: imageUploading }}
                closable={!imageUploading}
                destroyOnHidden
            >
                <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
                    <Form form={form} layout="vertical" requiredMark={false} initialValues={{ kind: "text", category: "other", tags: [] }}>
                        <Form.Item name="kind" label="类型">
                            <Select
                                options={[
                                    { label: "文本", value: "text" },
                                    { label: "图片", value: "image" },
                                ]}
                                onChange={(value) => setFormKind(value)}
                            />
                        </Form.Item>
                        <Form.Item name="folderId" label="分类">
                            <Select options={folderSelectOptions} />
                        </Form.Item>
                        <Form.Item name="title" label="标题" rules={[{ required: true, message: "请输入标题" }]}>
                            <Input placeholder="给素材起一个容易检索的名字" />
                        </Form.Item>
                        <Form.Item name="coverUrl" label="封面 URL">
                            <Space.Compact className="w-full">
                                <Input placeholder="可粘贴图片 URL，也可以上传本地封面" />
                                <Button icon={<Upload className="size-3.5" />} onClick={() => coverInputRef.current?.click()}>
                                    上传
                                </Button>
                            </Space.Compact>
                        </Form.Item>

                        <div className="grid gap-4 sm:grid-cols-2">
                            <Form.Item name="arkAssetId" label="方舟素材 ID" rules={[{ pattern: /^asset-[A-Za-z0-9-]+$/, message: "请输入 asset- 开头的方舟素材 ID" }]}>
                                <Input autoComplete="off" allowClear placeholder="asset-…，需为本人或被授权可用的方舟素材" />
                            </Form.Item>
                            <Form.Item name="portraitCertified" label="人像认证" valuePropName="checked" extra="标记已通过火山方舟实人认证的真人人像素材">
                                <Switch aria-label="人像认证" />
                            </Form.Item>
                        </div>
                        <div className="grid gap-4 sm:grid-cols-2">
                            <Form.Item name="source" label="来源">
                                <Input placeholder="手动添加 / 画布 / 任务中心" />
                            </Form.Item>
                            <Form.Item name="note" label="备注">
                                <Input placeholder="可选" />
                            </Form.Item>
                        </div>
                        {formKind === "text" ? (
                            <Form.Item name="content" label="文本内容" rules={[{ required: true, message: "请输入文本内容" }]}>
                                <Input.TextArea rows={8} placeholder="保存提示词、说明文案、参考描述等文本素材" />
                            </Form.Item>
                        ) : (
                            <Form.Item label="图片内容" required>
                                <div className="rounded-lg border border-dashed border-stone-300 p-4 dark:border-stone-700">
                                    <Button disabled={imageUploading} icon={<Upload className="size-4" />} onClick={() => imageInputRef.current?.click()}>
                                        {imageUploading ? (remoteMode ? "正在上传图片" : "正在保存图片") : "选择图片文件"}
                                    </Button>
                                    {imageFile ? (
                                        <Tag color="gold" className="ml-3">
                                            待保存上传
                                        </Tag>
                                    ) : null}
                                    {imageDraft ? (
                                        <Typography.Text type="secondary" className="ml-3 text-xs" title={resourceStorageTitle(imageDraft.storageKey)}>
                                            {imageDraft.width}x{imageDraft.height} · {formatBytes(imageDraft.bytes)} · {resourceStorageLabel(imageDraft.storageKey)}
                                        </Typography.Text>
                                    ) : (
                                        <Typography.Text type="secondary" className="ml-3 text-xs">
                                            未选择图片
                                        </Typography.Text>
                                    )}
                                </div>
                            </Form.Item>
                        )}
                    </Form>
                    <div className="lg:pl-4">
                        <Typography.Text strong className="text-xs">
                            预览
                        </Typography.Text>
                        <div className="mt-2 overflow-hidden rounded-md bg-stone-100 dark:bg-stone-900">
                            {coverUrl || imageDraft?.dataUrl ? (
                                <div className={`asset-preview-uploading ${imageUploading ? "is-uploading" : ""}`}>
                                    <img src={coverUrl || imageDraft?.dataUrl} alt="" loading="lazy" decoding="async" className="aspect-[4/3] w-full object-cover" />
                                    {imageUploading && imageUploadProgress ? (
                                        <div className="asset-preview-uploading-panel">
                                            <div className="asset-preview-uploading-copy">
                                                <span>{imageUploadProgress.phase === "confirming" ? "正在确认资源" : remoteMode ? "正在上传到云端" : "正在保存到本地"}</span>
                                                {typeof imageUploadProgress.percent === "number" ? <strong>{imageUploadProgress.percent}%</strong> : null}
                                            </div>
                                            <Progress percent={imageUploadProgress.percent} showInfo={false} size="small" status="active" />
                                        </div>
                                    ) : null}
                                </div>
                            ) : (
                                <div className="flex aspect-[4/3] items-center justify-center bg-stone-100 p-5 text-center text-sm text-stone-500 dark:bg-stone-900">{content || "暂无封面"}</div>
                            )}
                            <div className="bg-background p-3">
                                <Typography.Text strong ellipsis className="block">
                                    {title || "未命名素材"}
                                </Typography.Text>

                            </div>
                        </div>
                    </div>
                </div>
                <input
                    ref={coverInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(event) => {
                        void readCoverFile(event.target.files?.[0]);
                        event.target.value = "";
                    }}
                />
                <input
                    ref={imageInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(event) => {
                        void readImageFile(event.target.files?.[0]);
                        event.target.value = "";
                    }}
                />
            </Modal>



            <AssetDrawer asset={previewAsset} onClose={() => setPreviewAsset(null)} onCopy={copyAssetText} onDownload={downloadImage} />

            <Modal
                className="library-modal library-confirm-modal assets-folder-create-modal"
                title="新建分类"
                open={folderEditor === "new"}
                confirmLoading={folderSaving}
                onCancel={() => { if (!folderSaving) { setFolderEditor(null); setFolderName(""); } }}
                onOk={() => void saveFolder()}
                okButtonProps={{ className: "assets-folder-create-confirm" }}
                okText="保存"
                cancelText="取消"
            >
                <Input autoFocus value={folderName} maxLength={40} placeholder="例如：角色参考、场景灵感" onChange={(event) => setFolderName(event.target.value)} onPressEnter={() => void saveFolder()} />
            </Modal>

            <input ref={assetInputRef} type="file" accept="application/zip,.zip" className="hidden" onChange={(event) => void importAssetZip(event.target.files?.[0])} />
            <input
                ref={modelInputRef}
                type="file"
                accept=".glb,.gltf,model/gltf-binary,model/gltf+json"
                className="hidden"
                onChange={(event) => {
                    void readModelFile(event.target.files?.[0]);
                    event.currentTarget.value = "";
                }}
            />

            <Modal
                className="library-modal library-confirm-modal"
                title="永久删除素材"
                open={batchDeleteOpen}
                onCancel={() => { if (!deleteInFlight.current) setBatchDeleteOpen(false); }}
                onOk={() => void confirmBatchDelete()}
                confirmLoading={deletePending}
                okText="永久删除"
                okButtonProps={{ danger: true, disabled: !selectedAssets.length }}
                cancelButtonProps={{ disabled: deletePending }}
                cancelText="取消"
            >
                删除已选择的 {selectedAssets.length} 个素材后将无法恢复。仍被画布或任务引用的文件会保留，其余文件将同步清理。
            </Modal>
        </>
    );
}

function AssetCard({
    asset,
    selected,
    deleting,
    deletePending,
    onSelect,
    onOpen,
    onRename,
    onCopy,
    onDownload,
    onDelete,
    onConfirmDelete,
    onCancelDelete,
    folderOptions,
    onMoveToFolder,
}: {
    asset: LibraryAsset;
    selected: boolean;
    deleting: boolean;
    deletePending: boolean;
    onSelect: (selected: boolean) => void;
    onOpen: () => void;
    onRename: (title: string) => Promise<void>;
    onCopy: (asset: LibraryAsset) => void;
    onDownload: (asset: LibraryAsset) => void;
    onDelete: () => void;
    onConfirmDelete: () => Promise<void>;
    onCancelDelete: () => void;
    folderOptions: Array<{ label: string; value: string }>;
    onMoveToFolder: (folderId: string) => void;
}) {
    const [menuOpen, setMenuOpen] = useState(false);
    const [renaming, setRenaming] = useState(false);
    const [renameDraft, setRenameDraft] = useState(asset.title);
    const renameInFlight = useRef(false);
    const finishRename = async () => {
        if (renameInFlight.current) return;
        if (!renameDraft.trim()) { setRenameDraft(asset.title); setRenaming(false); return; }
        renameInFlight.current = true;
        try { await onRename(renameDraft); setRenaming(false); }
        catch { setRenameDraft(asset.title); }
        finally { renameInFlight.current = false; }
    };
    const deleteConfirmRequested = useRef(false);
    const openDeleteConfirm = () => {
        deleteConfirmRequested.current = true;
        setMenuOpen(true);
        onDelete();
    };
    const closeDeleteConfirm = () => {
        if (deletePending) return;
        deleteConfirmRequested.current = false;
        onCancelDelete();
    };
    const menuItems: MenuProps["items"] = [
        { key: "rename", icon: <PencilLine className="size-3.5" />, label: "重命名", onClick: () => { setRenameDraft(asset.title); setRenaming(true); } },
        ...(asset.kind === "text" ? [{ key: "copy", icon: <Copy className="size-3.5" />, label: "复制文本", onClick: () => void onCopy(asset) }] : []),
        ...(asset.kind === "image" || asset.kind === "video" || asset.kind === "audio" || asset.kind === "model" ? [{ key: "download", icon: <Download className="size-3.5" />, label: "下载", onClick: () => onDownload(asset) }] : []),
        { key: "move", icon: <FolderOpen className="size-3.5" />, label: "移动到分类", children: folderOptions.map((folder) => ({ key: folder.value || "uncategorized", label: folder.label, onClick: () => onMoveToFolder(folder.value) })) },
        { type: "divider" as const },
        { key: "delete", danger: true, icon: <Trash2 className="size-3.5" />, label: (
            <Popover
                open={deleting}
                onOpenChange={(open) => { if (open) openDeleteConfirm(); else closeDeleteConfirm(); }}
                afterOpenChange={(open) => { if (!open && !deleteConfirmRequested.current) setMenuOpen(false); }}
                trigger="click"
                placement="rightBottom"
                arrow={false}
                overlayClassName="asset-delete-confirm-popover"
                content={(
                    <div className="asset-delete-confirm-content" onClick={(event) => event.stopPropagation()}>
                        <p>确定删除该资产吗？删除后不可恢复。</p>
                        <div className="asset-delete-confirm-actions">
                            <Button size="small" disabled={deletePending} onClick={closeDeleteConfirm}>取消</Button>
                            <Button size="small" danger loading={deletePending} onClick={() => void onConfirmDelete()}>永久删除</Button>
                        </div>
                    </div>
                )}
            >
                <span className="asset-delete-confirm-trigger">永久删除</span>
            </Popover>
        ), onClick: openDeleteConfirm },
    ];
    return (
        <AssetLibraryCard selected={selected}>
            <AssetCover asset={asset} selected={selected} onSelect={onSelect} onOpen={onOpen} menuItems={menuItems} menuOpen={menuOpen} onMenuOpenChange={(open) => {
                if (!open && deleteConfirmRequested.current) return;
                setMenuOpen(open);
            }} onMenuAction={(key) => {
                if (key === "delete") return;
                deleteConfirmRequested.current = false;
                setMenuOpen(false);
                onCancelDelete();
            }} />
            <div role="button" tabIndex={0} onKeyDown={event => { if (!renaming && (event.key === "Enter" || event.key === " ")) onOpen(); }} className="asset-collection-body is-compact block w-full px-2.5 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--workspace-accent)]" onClick={() => { if (!renaming) onOpen(); }}>
                <div className="asset-card-meta">
                    {renaming ? <input autoFocus aria-label="素材名称" className="asset-inline-title" value={renameDraft} onFocus={event => event.target.select()} onClick={event => event.stopPropagation()} onChange={event => setRenameDraft(event.target.value)} onBlur={() => void finishRename()} onKeyDown={event => { event.stopPropagation(); if (event.key === "Enter") { event.preventDefault(); void finishRename(); } if (event.key === "Escape") { event.preventDefault(); setRenameDraft(asset.title); setRenaming(false); } }} /> : <h2 className="truncate text-[var(--fs-body)] font-semibold text-foreground" title={asset.title}>{asset.title}</h2>}
                    <span className="asset-collection-date tabular-nums">{formatAssetTime(asset.updatedAt)}</span>
                </div>
            </div>
        </AssetLibraryCard>
    );
}

function isKnownAssetKind(kind: unknown): kind is AssetKind {
    return kind === "image" || kind === "video" || kind === "audio" || kind === "model" || kind === "text";
}

function AssetCover({ asset, selected, onSelect, onOpen, menuItems, menuOpen, onMenuOpenChange, onMenuAction }: { asset: LibraryAsset; selected: boolean; onSelect: (selected: boolean) => void; onOpen: () => void; menuItems: MenuProps["items"]; menuOpen: boolean; onMenuOpenChange: (open: boolean) => void; onMenuAction: (key: string) => void }) {
    const kind = isKnownAssetKind(asset.kind) ? asset.kind : undefined;
    const KindIcon = kind ? assetKindIcons[kind] : FileText;
    const clock = asset.kind === "video" || asset.kind === "audio" ? formatAssetClock(asset.data.durationMs) : null;
    const showPlay = asset.kind === "video";
    const isLight = asset.kind === "audio" || asset.kind === "text" || asset.kind === "model";
    return (
        <AssetLibraryCardMedia className={isLight ? "assets-cover is-light" : "assets-cover"}>
            <button type="button" data-onboarding-asset={asset.id} className="assets-cover-link" onClick={onOpen} aria-label={`查看素材：${asset.title}`}>
                {asset.kind === "audio" ? (
                    <AudioWaveCover asset={asset} />
                ) : asset.kind === "text" ? (
                    <TextCover asset={asset} />
                ) : asset.kind === "model" ? (
                    <ModelCover asset={asset} />
                ) : (
                    <AssetMediaPreview
                        asset={asset}
                        alt={asset.title}
                        className="assets-cover-media"
                        fallback={
                            <div className="assets-cover-fallback">
                                <KindIcon className="size-7" />
                            </div>
                        }
                    />
                )}
                <span className="assets-cover-vignette" aria-hidden="true" />
                {showPlay ? (
                    <span className="assets-cover-play">
                        <Play className="size-4" />
                    </span>
                ) : null}
            </button>
            {clock ? <span className="assets-cover-clock">{clock}</span> : null}
            <input type="checkbox" checked={selected} onClick={(event) => event.stopPropagation()} onChange={(event) => onSelect(event.target.checked)} className="assets-select-check" aria-label={`选择 ${asset.title}`} />
            <Dropdown overlayClassName="asset-actions-menu" trigger={["click"]} open={menuOpen} onOpenChange={onMenuOpenChange} menu={{ items: menuItems, onClick: ({ key }) => onMenuAction(key) }}>
                <button
                    type="button"
                    className="assets-cover-more"
                    aria-label="更多素材操作"
                    aria-haspopup="menu"
                    title="更多操作"
                    onClick={(event) => event.stopPropagation()}
                >
                    <MoreHorizontal className="size-4" />
                </button>
            </Dropdown>
        </AssetLibraryCardMedia>
    );
}

function AudioWaveCover({ asset }: { asset: LibraryAsset & { kind: "audio" } }) {
    const bars = audioWaveBars(asset.id);
    return (
        <div className="assets-cover-wave" aria-hidden="true">
            {bars.map((height, index) => (
                <span key={index} style={{ height: `${height}%` }} />
            ))}
            <AudioLines className="assets-cover-wave-glyph" />
        </div>
    );
}

function TextCover({ asset }: { asset: LibraryAsset & { kind: "text" } }) {
    return (
        <div className="assets-cover-text">
            <p>{asset.data.content || "空白文本素材"}</p>
        </div>
    );
}

function ModelCover({ asset }: { asset: LibraryAsset & { kind: "model" } }) {
    return (
        <div className="assets-cover-model">
            <Box />
            <span>{asset.data.fileName}</span>
        </div>
    );
}

function AssetsBatchBar({
    count,
    allSelected,
    onSelectAll,
    onClear,
    onExport,
    onDelete,
    folderOptions,
    onMoveToFolder,
}: {
    count: number;
    allSelected: boolean;
    onSelectAll: () => void;
    onClear: () => void;
    onExport: () => void;
    onDelete: () => void;
    folderOptions: Array<{ label: string; value: string }>;
    onMoveToFolder: (folderId: string) => void;
}) {
    return (
        <div className="assets-batch-bar" role="toolbar" aria-label="批量操作">
            <span className="assets-batch-count">
                已选择 <strong>{count}</strong> 个素材
            </span>
            <div className="assets-batch-actions">
                <Button size="small" icon={<CheckCheck className="size-3.5" />} disabled={allSelected} onClick={onSelectAll}>
                    全选
                </Button>
                <Button size="small" onClick={onClear}>
                    取消选择
                </Button>
                <Button size="small" icon={<Download className="size-3.5" />} onClick={onExport}>
                    导出
                </Button>
                <Dropdown
                    trigger={["click"]}
                    menu={{ items: folderOptions.map((folder) => ({ key: folder.value || "uncategorized", label: folder.label, onClick: () => onMoveToFolder(folder.value) })) }}
                >
                    <Button size="small" icon={<FolderOpen className="size-3.5" />}>移动到文件夹</Button>
                </Dropdown>
                <Button size="small" danger icon={<Trash2 className="size-3.5" />} onClick={onDelete}>
                    永久删除
                </Button>
            </div>
        </div>
    );
}

function GenerationHistorySurface({
    assets,
    generatedTotal,
    generatedKindCounts,
    libraryTotal,
    kind,
    hasMore = false,
    loadingMore = false,
    loadMoreError = false,
    onKindChange,
    onLoadMore,
    onSelectPersonal,
    onDownload,
    onDelete,
}: {
    assets: LibraryAsset[];
    generatedTotal: number;
    generatedKindCounts: Record<string, number>;
    libraryTotal: number;
    kind?: GenerationHistoryKind;
    hasMore?: boolean;
    loadingMore?: boolean;
    loadMoreError?: boolean;
    onKindChange?: (kind: GenerationHistoryKind) => void;
    onLoadMore?: () => void;
    onSelectPersonal: () => void;
    onDownload: (asset: LibraryAsset) => void;
    onDelete: (asset: LibraryAsset) => Promise<boolean | undefined>;
}) {
    const [localKind, setLocalKind] = useState<GenerationHistoryKind>("all");
    const [sortDescending, setSortDescending] = useState(true);
    const [previewAsset, setPreviewAsset] = useState<LibraryAsset | null>(null);
    const [selectedHistoryIds, setSelectedHistoryIds] = useState<Set<string>>(new Set());
    const [pendingDelete, setPendingDelete] = useState<LibraryAsset[]>([]);
    const [deleting, setDeleting] = useState(false);
    const deleteInFlight = useRef(false);
    const confirmHistoryDelete = async () => {
        if (deleteInFlight.current || !pendingDelete.length) return;
        deleteInFlight.current = true;
        setDeleting(true);
        try {
            for (const asset of pendingDelete) {
                if (!await onDelete(asset)) continue;
                setPendingDelete((current) => current.filter((item) => item.id !== asset.id));
                setSelectedHistoryIds((current) => {
                    const next = new Set(current);
                    next.delete(asset.id);
                    return next;
                });
                setPreviewAsset((current) => current?.id === asset.id ? null : current);
            }
        } finally {
            deleteInFlight.current = false;
            setDeleting(false);
        }
    };
    const activeType = kind ?? localKind;
    const setActiveType = onKindChange ?? setLocalKind;
    const historyAssets = assets
        .filter(isWorkspaceGeneratedHistoryAsset)
        .sort((left, right) => {
            const delta = new Date(left.updatedAt).getTime() - new Date(right.updatedAt).getTime();
            return sortDescending ? -delta : delta;
        });
    const counts = {
        all: generatedTotal,
        image: generatedKindCounts.image || 0,
        video: generatedKindCounts.video || 0,
        audio: generatedKindCounts.audio || 0,
    };
    const typeTabs: Array<[GenerationHistoryKind, string, number]> = [["all", "全部", counts.all], ["image", "图片", counts.image], ["video", "视频", counts.video], ["audio", "音频", counts.audio]];
    const typeFilteredHistory = kind != null ? historyAssets : (activeType === "all" ? historyAssets : historyAssets.filter((asset) => asset.kind === activeType));
    const visibleHistoryAssets = typeFilteredHistory;
    const visibleGroups = [...new Set(visibleHistoryAssets.map((asset) => historyDay(asset.updatedAt)))];
    const selectedHistoryAssets = visibleHistoryAssets.filter((asset) => selectedHistoryIds.has(asset.id));
    const toggleHistorySelection = (assetId: string) => setSelectedHistoryIds((current) => {
        const next = new Set(current);
        if (next.has(assetId)) next.delete(assetId); else next.add(assetId);
        return next;
    });
    const clearHistorySelection = () => setSelectedHistoryIds(new Set());
    return (
        <>
        <WorkspacePage grid className="library-page assets-library-page canvas-library-page generation-history-page">
            <div className="studio-band assets-library-hero">
                <PageHeader
                    title="生成历史"
                    actions={
                        <div className="assets-header-actions">
                            <button type="button" className="assets-header-compact-button" aria-label={sortDescending ? "按时间倒序" : "按时间正序"} title={sortDescending ? "最新优先" : "最早优先"} onClick={() => setSortDescending((value) => !value)}><ArrowDownUp className="size-4" /></button>
                        </div>
                    }
                />
                <div className="generation-history-type-tabs" role="tablist" aria-label="生成类型">
                    {typeTabs.map(([value, label, count]) => (
                        <button key={value} type="button" className={cn("generation-history-type-tab", activeType === value && "is-active")} role="tab" aria-selected={activeType === value} onClick={() => setActiveType(value)}>
                            <span>{label}</span><strong>{count}</strong>
                        </button>
                    ))}
                </div>
            </div>
            <div className="generation-history-content">
                {selectedHistoryAssets.length ? <div className="generation-history-batch-bar" role="toolbar" aria-label="生成历史批量操作">
                    <span>已选择 {selectedHistoryAssets.length} 项</span>
                    <button type="button" onClick={() => selectedHistoryAssets.forEach(onDownload)}><Download className="size-3.5" />下载</button>
                    <button type="button" className="is-danger" onClick={() => setPendingDelete(selectedHistoryAssets)}><Trash2 className="size-3.5" />永久删除</button>
                    <button type="button" className="is-clear" onClick={clearHistorySelection}>取消选择</button>
                </div> : null}
                {visibleGroups.length ? visibleGroups.map((date) => (
                    <section key={date} className="generation-history-group">
                        <h2>{date}</h2>
                        <div className="generation-history-grid">
                            {visibleHistoryAssets.filter((asset) => historyDay(asset.updatedAt) === date).map((asset) => (
                                <article key={asset.id} data-onboarding-task-id={asset.metadata?.taskId} className="generation-history-card" title={asset.title} aria-label={`查看生成结果：${asset.title}`} role="button" tabIndex={0} onClick={() => setPreviewAsset(asset)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setPreviewAsset(asset); } }}>
                                    <div className="generation-history-thumb">
                                        <AssetMediaPreview asset={asset} alt={asset.title} className="size-full object-cover" hoverPlayDelayMs={100} fallback={<GenerationHistoryMissingPreview asset={asset} />} />
                                        <span className="generation-history-badge">AI生成</span>
                                        {asset.kind === "video" || asset.kind === "audio" ? <span className={cn("generation-history-duration", asset.kind === "video" && "is-video-duration")}>{formatAssetClock(asset.data.durationMs)}</span> : null}
                                        <button type="button" className={cn("generation-history-select", selectedHistoryIds.has(asset.id) && "is-selected")} aria-label={`选择 ${asset.title}`} aria-pressed={selectedHistoryIds.has(asset.id)} onClick={(event) => { event.stopPropagation(); toggleHistorySelection(asset.id); }}>{selectedHistoryIds.has(asset.id) ? <Check className="size-4" /> : null}</button>
                                        <div className="generation-history-hover-actions" aria-label="生成结果操作">
                                            <button type="button" aria-label={`下载 ${asset.title}`} title="下载" onClick={(event) => { event.stopPropagation(); onDownload(asset); }}><Download className="size-4" /></button>
                                            <button type="button" aria-label={`永久删除 ${asset.title}`} title="永久删除" onClick={(event) => { event.stopPropagation(); setPendingDelete([asset]); }}><Trash2 className="size-4" /></button>
                                        </div>
                                    </div>
                                    <div className="generation-history-card-meta"><strong>{asset.title}</strong><span>{asset.kind === "video" ? "视频" : asset.kind === "audio" ? "音频" : "图片"} · 本地</span></div>
                                </article>
                            ))}
                        </div>
                    </section>
                )) : <WorkspaceState icon="assets" compact title={historyAssets.length ? "没有匹配的生成结果" : "暂无生成历史"} description={historyAssets.length ? "切换类型后再试。" : "本地生成结果会自动出现在这里。"} />}
                {visibleGroups.length ? (
                    hasMore ? (
                        <div className="generation-history-more">
                            <button type="button" onClick={onLoadMore} disabled={loadingMore || !onLoadMore}>
                                {loadingMore ? "正在加载" : loadMoreError ? "加载失败，点击重试" : "加载更多"}
                            </button>
                        </div>
                    ) : (
                        <p className="generation-history-end">没有更多了</p>
                    )
                ) : null}
            </div>
            <aside className="assets-library-source-rail" aria-label="资产来源导航">
                <div className="assets-library-source-rail-inner">
                    <button type="button" className="assets-library-source-rail-item is-active" aria-current="page">
                        <span className="assets-library-source-rail-icon"><History className="size-3.5" /></span>
                        <span>生成历史</span><span className="assets-filter-count">{counts.all}</span>
                    </button>
                    <button type="button" className="assets-library-source-rail-item" onClick={onSelectPersonal}>
                        <span className="assets-library-source-rail-icon"><FolderOpen className="size-3.5" /></span>
                        <span>个人资产库</span><span className="assets-filter-count">{libraryTotal}</span>
                    </button>
                </div>
            </aside>
        </WorkspacePage>
        <Modal
            className="library-modal library-confirm-modal"
            title="永久删除生成素材"
            open={pendingDelete.length > 0}
            onCancel={() => { if (!deleteInFlight.current) setPendingDelete([]); }}
            onOk={() => void confirmHistoryDelete()}
            confirmLoading={deleting}
            closable={!deleting}
            cancelButtonProps={{ disabled: deleting }}
            okButtonProps={{ danger: true }}
            okText="永久删除"
            cancelText="取消"
        >
            {pendingDelete.length === 1 ? `删除「${pendingDelete[0].title}」后将无法恢复。` : `删除已选择的 ${pendingDelete.length} 个素材后将无法恢复。`}仍被画布或任务引用的文件会保留，其余文件将同步清理。
        </Modal>
        <Drawer className="assets-generation-preview-drawer" open={Boolean(previewAsset)} title={previewAsset?.title || "生成结果预览"} onClose={() => setPreviewAsset(null)} size="default">
            {previewAsset ? <div className="generation-history-preview"><AssetMediaPreview asset={previewAsset} alt={previewAsset.title} className="generation-history-preview-media" fallback={<GenerationHistoryMissingPreview asset={previewAsset} />} /><div className="generation-history-preview-meta"><strong>{previewAsset.title}</strong><span>{previewAsset.kind === "video" ? "视频" : previewAsset.kind === "audio" ? "音频" : "图片"} · 本地生成</span><span>来源：{previewAsset.source || "生成任务"}</span>{typeof previewAsset.metadata?.taskId === "string" ? <span>任务 ID：{previewAsset.metadata.taskId}</span> : null}{typeof previewAsset.metadata?.generationEffectKey === "string" ? <span>生成标识：{previewAsset.metadata.generationEffectKey}</span> : null}</div></div> : null}
        </Drawer>
        </>
    );
}

function GenerationHistoryMissingPreview({ asset }: { asset: LibraryAsset }) {
    const kind = asset.kind === "video" ? "视频" : asset.kind === "audio" ? "音频" : "图片";
    const taskId = typeof asset.metadata?.taskId === "string" ? asset.metadata.taskId : "任务记录存在";
    return <div className="generation-history-missing-preview"><strong>生成{kind}暂不可用</strong><span>{taskId}</span><small>原始生成资源未找到或已失效</small></div>;
}

function AssetsEmptyState({ onImport }: { onImport: () => void }) {
    return (
        <div className="assets-empty assets-empty-workspace">
            <div className="assets-empty-copy">
                <span className="assets-empty-icon"><FileX2 /></span>
                <strong>当前暂无资产</strong>
            </div>
            <button type="button" className="assets-empty-primary" onClick={onImport}>
                <span>上传资产</span>
            </button>
        </div>
    );
}

function AssetFilterGroup({
    title,
    options,
    value,
    counts,
    onChange,
    className = "",
}: {
    title: string;
    options: Array<{ label: string; value: string }>;
    value: string;
    counts: Map<string, number>;
    onChange: (value: string) => void;
    className?: string;
}) {
    return (
        <div className={`collection-filter-group ${className}`}>
            <span className="collection-filter-label">{title}</span>
            <div className="collection-filter-options">
                {options.map((option) => {
                    const active = value === option.value;
                    return (
                        <button key={option.value} type="button" aria-pressed={active} className={`assets-filter-item ${active ? "is-active" : ""}`} onClick={() => onChange(option.value)}>
                            <span className="assets-filter-item-label">{option.label}</span>
                            <span className="assets-filter-count">{counts.get(option.value) || 0}</span>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

export function AssetVideoPreview({ storageKey, url, title, className }: { storageKey?: string; url: string; title: string; className: string }) {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const playback = useResourceVideoPlayback(storageKey || "", url);
    const source = playback.url;
    const error = Boolean(playback.error);
    const [playing, setPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [volume, setVolume] = useState(1);
    const [muted, setMuted] = useState(false);
    return (
        <div className="asset-video-player">
            {source ? (
                <>
                    <video
                        ref={videoRef}
                        src={source}
                        playsInline
                        preload="metadata"
                        aria-label={title}
                        className={className}
                        onError={() => { if (!playback.requestCompatible()) playback.fail(); }}
                        onPlay={() => setPlaying(true)}
                        onPause={() => setPlaying(false)}
                        onLoadedMetadata={(event) => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
                        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
                        onVolumeChange={(event) => {
                            setMuted(event.currentTarget.muted);
                            setVolume(event.currentTarget.volume);
                        }}
                    />
                    <div className="asset-video-controls" aria-label="视频播放控制">
                        <button type="button" className="asset-video-control-button" aria-label={playing ? "暂停" : "播放"} onClick={() => {
                            const video = videoRef.current;
                            if (!video) return;
                            if (video.paused) void video.play().catch(() => playback.fail());
                            else video.pause();
                        }}>
                            {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
                        </button>
                        <span className="asset-video-time">{formatAssetClock(currentTime * 1000) || "0:00"}</span>
                        <input
                            className="asset-video-seek"
                            type="range"
                            min={0}
                            max={Math.max(duration, 0.1)}
                            step={0.1}
                            value={Math.min(currentTime, duration || 0)}
                            aria-label="播放进度"
                            onChange={(event) => {
                                const time = Number(event.currentTarget.value);
                                if (videoRef.current) videoRef.current.currentTime = time;
                                setCurrentTime(time);
                            }}
                        />
                        <span className="asset-video-time">{formatAssetClock(duration * 1000) || "0:00"}</span>
                        <div className="asset-video-volume">
                            <button type="button" className="asset-video-control-button" aria-label={muted || volume === 0 ? "开启声音" : "静音"} onClick={() => {
                                const video = videoRef.current;
                                if (!video) return;
                                video.muted = !video.muted;
                                setMuted(video.muted);
                            }}>
                                {muted || volume === 0 ? <VolumeX aria-hidden="true" /> : <Volume2 aria-hidden="true" />}
                            </button>
                            <input
                                className="asset-video-volume-slider"
                                type="range"
                                min={0}
                                max={1}
                                step={0.05}
                                value={volume}
                                aria-label="音量"
                                onChange={(event) => {
                                    const nextVolume = Number(event.currentTarget.value);
                                    if (videoRef.current) {
                                        videoRef.current.volume = nextVolume;
                                        videoRef.current.muted = nextVolume === 0;
                                    }
                                    setVolume(nextVolume);
                                    setMuted(nextVolume === 0);
                                }}
                            />
                        </div>
                        <button type="button" className="asset-video-control-button" aria-label="全屏" onClick={() => void videoRef.current?.requestFullscreen?.()}>
                            <Maximize2 aria-hidden="true" />
                        </button>
                    </div>
                </>
            ) : null}
            {!source && !error ? <span className="text-sm text-white/65">正在加载视频…</span> : null}
            {error ? (
                <div className="absolute inset-0 grid place-content-center justify-items-center gap-3 bg-black px-4 text-center text-sm text-white/80">
                    <span>视频加载失败，请检查资源服务后重试。</span>
                    <Button size="small" onClick={playback.retry}>重试</Button>
                </div>
            ) : null}
        </div>
    );
}

function AssetDrawer({ asset, onClose, onCopy, onDownload }: { asset: LibraryAsset | null; onClose: () => void; onCopy: (asset: LibraryAsset) => void; onDownload: (asset: LibraryAsset) => void }) {
    const [playable, setPlayable] = useState<{ asset: LibraryAsset; url: string } | null>(null);
    useEffect(() => {
        if (!asset || asset.kind !== "audio") {
            setPlayable(null);
            return;
        }
        let cancelled = false;
        // Native media elements cannot attach the desktop session token.
        // Resolve the owned resource just as the library thumbnails do.
        void resolveMediaUrl(asset.data.storageKey, asset.data.url).then((url) => {
            if (!cancelled) setPlayable({ asset, url });
        }).catch(() => {
            if (!cancelled) setPlayable(null);
        });
        return () => { cancelled = true; };
    }, [asset]);
    const mediaUrl = playable?.asset === asset ? playable?.url : undefined;
    const facts = asset ? assetArchiveFacts(asset) : [];
    return (
        <Drawer className="library-drawer asset-detail-drawer" title={null} closable={false} open={Boolean(asset)} size="large" onClose={onClose}>
            {asset ? (
                <div className="space-y-4">
                    <div className="asset-archive-header">
                        <h2 className="asset-archive-title min-w-0">{asset.title}</h2>
                        <Button type="text" className="asset-detail-close" icon={<X className="size-4" />} aria-label="关闭资产详情" onClick={onClose} />
                    </div>
                    <div className="asset-archive-preview">
                        {asset.kind === "text" ? (
                            <div className="asset-archive-preview-note">{asset.data.content}</div>
                        ) : asset.kind === "audio" ? (
                            <div className="asset-archive-audio">
                                <audio src={mediaUrl} controls />
                            </div>
                        ) : asset.kind === "model" ? (
                            <div className="asset-archive-preview-model">
                                <Box />
                                <span>
                                    {asset.data.fileName} · {formatBytes(asset.data.bytes)}
                                </span>
                            </div>
                        ) : asset.kind === "video" ? (
                            <AssetVideoPreview storageKey={asset.data.storageKey} url={asset.data.url} title={asset.title} className="asset-archive-preview-media" />
                        ) : (
                            <AssetImageZoom asset={asset} />
                        )}
                    </div>
                    <div className="flex flex-wrap gap-1.5">

                        {asset.arkAssetId ? (
                            <Tag className="m-0" color="geekblue" title="火山方舟素材 ID，生成视频时可直接 asset:// 引用">
                                方舟 {asset.arkAssetId}
                            </Tag>
                        ) : null}
                    </div>
                    <div className="asset-archive-facts">
                        {facts.map((fact) => (
                            <div key={fact.label} className="asset-archive-fact">
                                <span className="asset-archive-fact-label">{fact.label}</span>
                                <span className="asset-archive-fact-value" title={fact.value}>
                                    {fact.value}
                                </span>
                            </div>
                        ))}
                    </div>
                    {asset.note ? (
                        <div className="asset-archive-section">
                            <span className="asset-archive-section-title">备注</span>
                            <p className="asset-archive-section-body">{asset.note}</p>
                        </div>
                    ) : null}
                    <div className="asset-archive-actions">
                        {asset.kind === "text" ? (
                            <Button type="primary" icon={<Copy className="size-4" />} onClick={() => onCopy(asset)}>
                                复制文本
                            </Button>
                        ) : null}
                        {asset.kind === "image" || asset.kind === "video" || asset.kind === "audio" || asset.kind === "model" ? (
                            <Button className="asset-detail-download" icon={<Download className="size-4" />} onClick={() => onDownload(asset)}>
                                {assetDownloadLabel(asset)}
                            </Button>
                        ) : null}
                    </div>
                </div>
            ) : null}
        </Drawer>
    );
}

function AssetImageZoom({ asset }: { asset: LibraryAsset & { kind: "image" } }) {
    const [scale, setScale] = useState(1);
    const [offset, setOffset] = useState({ x: 0, y: 0 });
    const [retry, setRetry] = useState(0);
    const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
    const reset = () => { setScale(1); setOffset({ x: 0, y: 0 }); };
    return (
        <div className="asset-zoom-viewer" onWheel={(event) => { event.preventDefault(); setScale((value) => Math.min(4, Math.max(.25, value * (event.deltaY < 0 ? 1.12 : .89)))); }} onPointerDown={(event) => { if (scale <= 1) return; event.currentTarget.setPointerCapture(event.pointerId); dragRef.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y }; }} onPointerMove={(event) => { const drag = dragRef.current; if (!drag) return; setOffset({ x: drag.ox + event.clientX - drag.x, y: drag.oy + event.clientY - drag.y }); }} onPointerUp={() => { dragRef.current = null; }} onPointerCancel={() => { dragRef.current = null; }}>
            {/* Desktop resource images require the authenticated cache path used by asset cards. */}
            <CachedResourceImage
                key={`${asset.id}:${retry}`}
                storageKey={asset.data.storageKey}
                src={asset.coverUrl || asset.data.dataUrl}
                alt={asset.title}
                eager
                decoding="async"
                className="asset-archive-preview-media asset-zoom-image"
                style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
                loadingFallback={<span className="text-sm text-white/65">正在加载图片…</span>}
                fallback={<div className="grid justify-items-center gap-3 text-sm text-white/75"><span>图片加载失败，请重试。</span><Button size="small" onClick={() => setRetry((value) => value + 1)}>重试</Button></div>}
            />
            <div className="asset-zoom-controls" data-canvas-no-zoom>
                <button type="button" title="缩小" aria-label="缩小" onClick={() => setScale((value) => Math.max(.25, value / 1.25))}><ZoomOut className="size-4" /></button>
                <button type="button" title="恢复适应" aria-label="恢复适应" onClick={reset}>{Math.round(scale * 100)}%</button>
                <button type="button" title="放大" aria-label="放大" onClick={() => setScale((value) => Math.min(4, value * 1.25))}><ZoomIn className="size-4" /></button>
                <button type="button" title="查看原图尺寸" aria-label="查看原图尺寸" onClick={() => setScale(1)}><Maximize2 className="size-4" /></button>
            </div>
        </div>
    );
}

function assetArchiveFacts(asset: LibraryAsset) {
    const facts: Array<{ label: string; value: string }> = [
        { label: "类型", value: assetKindLabel(asset.kind) },
        { label: "分类", value: assetCategoryLabel(asset.category) },
    ];
    if (asset.kind === "image" || asset.kind === "video") {
        facts.push({ label: "尺寸", value: assetSizeLabel(asset.data.width, asset.data.height) });
    }
    if (asset.kind === "video" || asset.kind === "audio") {
        facts.push({ label: "时长", value: formatAssetClock(asset.data.durationMs) || "未知" });
    }
    if (asset.kind !== "text") {
        facts.push({ label: "大小", value: formatBytes(asset.data.bytes) });
        facts.push({ label: "格式", value: asset.data.mimeType });
    }
    facts.push({ label: "来源", value: asset.source || "未标注" });
    facts.push({ label: "创建", value: formatAssetDateTime(asset.createdAt) });
    return facts;
}

function assetSizeLabel(width: number, height: number) {
    return width > 0 && height > 0 ? `${width}x${height}` : "未知";
}

function assetSearchText(asset: LibraryAsset) {
    return [asset.title, asset.source || "", asset.note || "", assetCategoryLabel(asset.category), asset.kind === "text" ? asset.data.content : asset.data.mimeType].join(" ").toLowerCase();
}

function assetKindLabel(kind: AssetKind) {
    return kind === "image" ? "图片" : kind === "video" ? "视频" : kind === "audio" ? "音频" : kind === "model" ? "模型" : "文本";
}

function assetDownloadLabel(asset: LibraryAsset) {
    if (asset.kind === "video") return "下载视频";
    if (asset.kind === "audio") return "下载音频";
    if (asset.kind === "model") return "下载模型";
    return "下载图片";
}

function readAssetViewMode(): "grid" | "list" {
    if (typeof window === "undefined") return "grid";
    return window.localStorage.getItem(ASSET_VIEW_MODE_KEY) === "list" ? "list" : "grid";
}

function assetCountMap<T extends { label: string; value: string }>(options: T[], remote: Record<string, number> | undefined, fallback: LibraryAsset[], valueOf: (asset: LibraryAsset) => string) {
    const result = new Map<string, number>();
    options.forEach((option) => {
        // 列表只展示 LibraryAsset（entity 角色卡被排除）；"全部"计数只能累加选项里声明的类型，
        // 否则远端 facets 里的 entity 会计入"全部"，出现计数 30 但列表为空的矛盾。
        if (remote) result.set(option.value, option.value === "all" ? options.reduce((sum, item) => item.value === "all" ? sum : sum + (remote[item.value] || 0), 0) : remote[option.value] || 0);
        else result.set(option.value, option.value === "all" ? fallback.length : fallback.filter((asset) => valueOf(asset) === option.value).length);
    });
    return result;
}

function formatAssetClock(durationMs?: number) {
    if (!durationMs || durationMs < 1000) return null;
    const total = Math.round(durationMs / 1000);
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatAssetTime(value: string) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "-" : date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

function historyDay(value: string) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "未知日期" : date.toISOString().slice(0, 10);
}

function formatAssetDateTime(value: string) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "-";
    return date.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function audioWaveBars(seed: string) {
    let hash = 0;
    for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    const bars: number[] = [];
    for (let index = 0; index < 26; index += 1) {
        hash = (hash * 9301 + 49297) % 233280;
        const random = hash / 233280;
        const envelope = 0.35 + 0.65 * Math.abs(Math.sin(index * 0.55 + 1.2));
        bars.push(Math.round((0.18 + 0.82 * random * envelope) * 100));
    }
    return bars;
}
