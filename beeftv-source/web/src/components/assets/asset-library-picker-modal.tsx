import { Button, Dropdown } from "antd";
import type { MenuProps } from "antd";
import { AppModal } from "@/components/ui/product/app-modal";
import { Check, ChevronDown, FileText, FolderOpen, HardDrive, Image as ImageIcon, LoaderCircle, Music2, Puzzle, Search, Upload, UserRound, Video } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useUserStore } from "@/stores/use-user-store";

import { AssetMediaPreview } from "@/components/asset-media-preview";
import { AssetLibraryCard } from "@/components/assets/asset-library-card";
import {
    assetPickerQueryKey,
    expectedScopeFromQueryKey,
    runAssetViewAction,
    shouldSuppressAssetViewError,
    useAssetViewGeneration,
} from "@/components/assets/asset-view-session";
import { captureUserScope, userScopeMatches, type CapturedUserScope } from "@/lib/user-scope-guard";
import { CachedResourceImage } from "@/components/cached-resource-image";
import { PaginationBar } from "@/components/layout/workspace-page";
import { cn } from "@/lib/utils";
import type { ExternalAssetPickerReference } from "@/lib/plugins/plugin-types";
import type { Asset } from "@/stores/use-asset-store";
import { loadAssetLibraryPage } from "@/services/local-workspace-sync";
import { isUnsavedWorkspaceAsset, usesWorkspaceAssetLibraryApi, workspaceAssetTraversalTotal } from "@/services/workspace-asset-read";

export type AssetPickerMediaKind = "image" | "video" | "audio" | "text";

export const ASSET_PICKER_MEDIA_KIND_LABELS: Record<AssetPickerMediaKind, string> = { image: "图片", video: "视频", audio: "音频", text: "文本" };

const DEFAULT_MEDIA_KINDS: AssetPickerMediaKind[] = ["image", "video", "audio"];

export type AssetLibraryPickerItem = {
    id: string;
    title: string;
    category: string;
    archived?: boolean;
    kindLabel: string;
    /** 媒体类型筛选依据；缺省时按本地素材或插件素材的 kind 推断。 */
    mediaKind?: AssetPickerMediaKind;
    asset?: Asset;
    imageUrl?: string;
    imageStorageKey?: string;
    imageFit?: "cover" | "contain";
    description?: string;
    searchText?: string;
    disabledReason?: string;
    folderId?: string;
    external?: ExternalAssetPickerReference;
};

export type AssetLibraryPickerFolder = {
    id: string;
    parentId?: string;
    name: string;
};

type Props = {
    remoteLibrary?: boolean;
    remoteKind?: string;
    /** 左侧「媒体类型」筛选项；只有一种类型或已由 remoteKind 固定时不展示该分组。 */
    mediaKinds?: AssetPickerMediaKind[];
    open: boolean;
    items: AssetLibraryPickerItem[];
    categoryLabels: Record<string, string>;
    initialCategory?: string;
    initialFolderId?: string;
    folders?: AssetLibraryPickerFolder[];
    initialSelectedIds?: Iterable<string>;
    multiple?: boolean;
    title?: string;
    eyebrow?: string;
    confirmLabel?: (count: number) => string;
    emptyTitle?: string;
    emptyDescription?: string;
    footerNote?: string;
    loading?: boolean;
    pagination?: { current: number; pageSize: number; total: number; onChange: (page: number, pageSize: number) => void };
    folderActionLabel?: string;
    folderActionSource?: "local" | "all";
    upload?: {
        accept: string;
        description: string;
        onUpload: (files: FileList, expectedScope: CapturedUserScope) => Promise<string[]>;
        external?: {
            accept: string;
            description: string;
            onUpload: (files: FileList, folderId: string | undefined, expectedScope: CapturedUserScope) => Promise<AssetLibraryPickerItem[]>;
        };
    };
    onClose: () => void;
    onConfirm: (ids: string[], expectedScope: CapturedUserScope) => Promise<void> | void;
    onFolderAction?: (folderId: string, expectedScope: CapturedUserScope) => Promise<void> | void;
};

export function AssetLibraryPickerModal(props: Props) {
    const queryClient = useQueryClient();
    const generation = useAssetViewGeneration(queryClient);
    return <AssetLibraryPickerModalSession key={generation} {...props} />;
}

function AssetLibraryPickerModalSession({
    remoteLibrary = false,
    remoteKind,
    mediaKinds = DEFAULT_MEDIA_KINDS,
    open,
    items,
    categoryLabels,
    initialCategory = "all",
    initialFolderId = "all",
    folders = [],
    initialSelectedIds,
    multiple = true,
    title = "素材库",
    eyebrow = "参考内容",
    confirmLabel = (count) => `使用已选素材${count ? `（${count}）` : ""}`,
    emptyTitle = "这个分类还没有素材",
    emptyDescription = "换个分类后再试。",
    footerNote,
    loading = false,
    pagination,
    folderActionLabel = "将文件夹放到画布",
    folderActionSource = "all",
    upload,
    onClose,
    onConfirm,
    onFolderAction,
}: Props) {
    const [entryScope] = useState(() => captureUserScope());
    const [category, setCategory] = useState(initialCategory);
    const [mediaKind, setMediaKind] = useState<AssetPickerMediaKind | "all">("all");
    const [folderId, setFolderId] = useState(initialFolderId);
    const [source, setSource] = useState<"local" | "plugin">("local");
    const [sourceMenuOpen, setSourceMenuOpen] = useState(false);
    const [keyword, setKeyword] = useState("");
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [uploadedItems, setUploadedItems] = useState<AssetLibraryPickerItem[]>([]);
    const [working, setWorking] = useState(false);
    const [uploadingCount, setUploadingCount] = useState(0);
    const [error, setError] = useState("");
    const userId = useUserStore((state) => state.user?.id);
    const sessionHydrated = useUserStore((state) => state.hydrated);
    const [remotePage, setRemotePage] = useState(1);
    const [remotePageSize, setRemotePageSize] = useState(40);
    const [remoteKeyword, setRemoteKeyword] = useState("");
    const remoteEnabled = remoteLibrary && usesWorkspaceAssetLibraryApi() && Boolean(userId) && source === "local";
    useEffect(() => {
        const timer = window.setTimeout(() => setRemoteKeyword(keyword.trim()), 250);
        return () => window.clearTimeout(timer);
    }, [keyword]);
    useEffect(() => setRemotePage(1), [category, mediaKind, remoteKeyword, open]);
    // remoteKind 是调用方写死的能力约束；媒体类型筛选只在没有该约束时参与服务端查询。
    const remoteQueryKind = remoteKind || (mediaKind === "all" ? undefined : mediaKind);
    const remoteQuery = useQuery({
        queryKey: assetPickerQueryKey(entryScope, remotePage, remotePageSize, category, remoteKeyword, remoteQueryKind),
        queryFn: ({ queryKey, signal }) => loadAssetLibraryPage({
            page: remotePage,
            pageSize: remotePageSize,
            kind: remoteQueryKind,
            category: category === "all" || category === remoteQueryKind ? undefined : category,
            status: "active",
            query: remoteKeyword,
            signal,
            expectedScope: expectedScopeFromQueryKey(queryKey),
        }),
        enabled: remoteEnabled && open && sessionHydrated,
    });
    const remoteItems = useMemo<AssetLibraryPickerItem[]>(() => (remoteQuery.data?.assets || []).filter((asset) => asset.kind !== "entity" && asset.kind !== "model").map((asset) => {
        const parent = items.find((item) => item.id === asset.id);
        return {
            ...parent,
            id: asset.id,
            title: asset.title,
            category: asset.category || "other",
            archived: asset.status === "archived",
            asset,
            kindLabel: asset.kind === "image" ? "图片" : asset.kind === "video" ? "视频" : asset.kind === "audio" ? "音频" : "文本",
            mediaKind: pickerAssetMediaKind(asset),
            searchText: (asset.tags ?? []).join(" "),
            disabledReason: workspaceAssetPickerDisabledReason(asset, items, mediaKinds, remoteKind),
        };
    }), [items, mediaKinds, remoteKind, remoteQuery.data]);
    const uploadInputRef = useRef<HTMLInputElement>(null);
    const initialSelectedIdsRef = useRef(initialSelectedIds);
    const itemsRef = useRef(items);
    initialSelectedIdsRef.current = initialSelectedIds;
    const allItems = useMemo(() => {
        const known = new Set(items.map((item) => item.id));
        return [...items, ...uploadedItems.filter((item) => !known.has(item.id))];
    }, [items, uploadedItems]);
    itemsRef.current = allItems;
    const localItems = useMemo(() => allItems.filter((item) => !item.external), [allItems]);
    const remoteTotal = remoteQuery.data?.total ?? 0;
    const remoteReady = remoteEnabled && remoteQuery.isSuccess;
    const useRemoteItems = Boolean(remoteReady);
    const traversalTotal = remoteReady && remoteQuery.data ? workspaceAssetTraversalTotal(remoteQuery.data) : (pagination?.total ?? 0);
    const effectivePagination = useRemoteItems ? { current: remotePage, pageSize: remotePageSize, total: traversalTotal, onChange: (page: number, pageSize: number) => { setRemotePage(page); setRemotePageSize(pageSize); } } : pagination;
    useEffect(() => {
        if (!remoteEnabled) return;
        const maxPage = Math.max(1, Math.ceil(traversalTotal / remotePageSize));
        setRemotePage((value) => Math.min(value, maxPage));
    }, [remoteEnabled, remotePageSize, traversalTotal]);
    const pluginItems = useMemo(() => allItems.filter((item) => Boolean(item.external)), [allItems]);
    const hasPluginSource = useMemo(() => Object.keys(categoryLabels).some((value) => value.startsWith("external:")) || pluginItems.some((item) => item.category.startsWith("external:")), [categoryLabels, pluginItems]);
    // 媒体类型在分类之前收窄数据源，让左侧分类计数、网格和分页始终描述同一批素材。
    const sourceItems = useMemo(() => {
        const base = source === "plugin" ? pluginItems : useRemoteItems ? remoteItems : localItems;
        if (mediaKind === "all") return base;
        return base.filter((item) => pickerItemMediaKind(item) === mediaKind);
    }, [localItems, mediaKind, pluginItems, useRemoteItems, remoteItems, source]);
    const activeSourceItems = useMemo(() => sourceItems.filter((item) => !item.archived), [sourceItems]);
    const mediaKindOptions = useMemo(() => (remoteKind ? [] : Array.from(new Set(mediaKinds))), [mediaKinds, remoteKind]);
    const sourceFolders = source === "plugin" ? folders : [];
    const showCategories = source === "local" || !sourceFolders.length;
    const normalCategories = useMemo(() => useRemoteItems ? Object.keys(categoryLabels).filter((value) => value !== "archived" && !value.startsWith("external:")) : ["all", ...Array.from(new Set(activeSourceItems.map((item) => item.category || "other"))).filter((value) => value !== "all")], [activeSourceItems, categoryLabels, useRemoteItems]);

    const visibleItems = useMemo(() => {
        const query = keyword.trim().toLowerCase();
        return sourceItems.filter((item) => {
            if (item.archived || (category !== "all" && item.category !== category)) return false;
            if (folderId !== "all" && (item.folderId || "") !== folderId) return false;
            return useRemoteItems || !query || [item.title, item.searchText || "", item.description || ""].join(" ").toLowerCase().includes(query);
        });
    }, [category, folderId, keyword, sourceItems, useRemoteItems]);
    const selectedIds = useMemo(
        () =>
            Array.from(selected).filter((id) => {
                const item = resolvePickerCatalogItem(id, allItems, useRemoteItems ? remoteItems : []);
                return item ? !item.disabledReason : false;
            }),
        [allItems, remoteItems, selected, useRemoteItems],
    );

    useEffect(() => {
        if (!open) return;

        setFolderId(initialFolderId);
        setCategory(initialCategory);
        setMediaKind("all");
        setSource("local");
        setKeyword("");
        setUploadedItems([]);
        const selectableIds = new Set(itemsRef.current.filter((item) => !item.disabledReason).map((item) => item.id));
        setSelected(new Set(Array.from(initialSelectedIdsRef.current || []).filter((id) => selectableIds.has(id))));
        setWorking(false);
        setUploadingCount(0);
        setError("");
    }, [initialCategory, initialFolderId, open]);

    useEffect(() => {
        if (category === "all" || normalCategories.includes(category)) return;
        setCategory("all");
    }, [normalCategories, category]);

    useEffect(() => {
        if (hasPluginSource || source === "local") return;
        setSource("local");
    }, [hasPluginSource, source]);

    useEffect(() => {
        if (mediaKind === "all" || mediaKindOptions.includes(mediaKind)) return;
        setMediaKind("all");
    }, [mediaKind, mediaKindOptions]);

    const selectSource = (nextSource: "local" | "plugin") => {
        if (nextSource === "plugin" && !hasPluginSource) return;
        setSource(nextSource);
        setCategory("all");
        setFolderId("all");
        setError("");
    };

    const toggle = (item: AssetLibraryPickerItem) => {
        if (item.disabledReason || working) return;
        setError("");
        setSelected((current) => {
            if (!multiple) return current.has(item.id) ? new Set() : new Set([item.id]);
            const next = new Set(current);
            if (next.has(item.id)) next.delete(item.id);
            else next.add(item.id);
            return next;
        });
    };

    const confirm = async () => {
        if (!selectedIds.length || working) return;
        setWorking(true);
        setError("");
        try {
            const confirmed = await runAssetViewAction(entryScope, async (scope) => {
                await onConfirm(selectedIds, scope);
                return true;
            });
            if (!confirmed) return;
        } catch (reason) {
            if (shouldSuppressAssetViewError(reason, entryScope)) return;
            setError(reason instanceof Error ? reason.message : "素材操作失败，请重试");
        } finally {
            if (userScopeMatches(entryScope)) setWorking(false);
        }
    };

    const handleUpload = async (files: FileList | null) => {
        if (!files?.length || working || (source === "local" && !upload) || (source === "plugin" && !upload?.external)) return;
        setWorking(true);
        setError("");
        setUploadingCount(files.length);
        try {
            const uploaded = await runAssetViewAction(entryScope, async (scope) => {
                if (source === "plugin") {
                    const items = await upload!.external!.onUpload(files, folderId === "all" ? undefined : folderId, scope);
                    return { kind: "plugin" as const, items };
                }
                const ids = await upload!.onUpload(files, scope);
                return { kind: "local" as const, ids };
            });
            if (!uploaded) return;
            if (uploaded.kind === "plugin") {
                setUploadedItems((current) => [...current, ...uploaded.items]);
                const ids = uploaded.items.map((item) => item.id);
                if (ids.length) setSelected((current) => new Set(multiple ? [...current, ...ids] : ids.slice(-1)));
            } else if (uploaded.ids.length) {
                setSelected((current) => new Set(multiple ? [...current, ...uploaded.ids] : uploaded.ids.slice(-1)));
            }
        } catch (reason) {
            if (shouldSuppressAssetViewError(reason, entryScope)) return;
            setError(reason instanceof Error ? reason.message : "素材上传失败，请重试");
        } finally {
            if (userScopeMatches(entryScope)) {
                if (uploadInputRef.current) uploadInputRef.current.value = "";
                setWorking(false);
                setUploadingCount(0);
            }
        }
    };

    const runFolderAction = async () => {
        if (!onFolderAction || folderId === "all" || working) return;
        setWorking(true);
        setError("");
        try {
            const done = await runAssetViewAction(entryScope, async (scope) => {
                await onFolderAction(folderId, scope);
                return true;
            });
            if (!done) return;
        } catch (reason) {
            if (shouldSuppressAssetViewError(reason, entryScope)) return;
            setError(reason instanceof Error ? reason.message : "文件夹操作失败，请重试");
        } finally {
            if (userScopeMatches(entryScope)) setWorking(false);
        }
    };

    const countFor = (value: string) => (value === "all" ? activeSourceItems.length : activeSourceItems.filter((item) => item.category === value).length);
    const sourceLabel = source === "plugin" ? "插件来源" : "本地素材";
    const sourceMenuItems: MenuProps["items"] = [
        {
            key: "local",
            icon: <HardDrive aria-hidden="true" />,
            label: (
                <span className="asset-picker-source-menu-label">
                    <span>本地素材</span>
                    <em>{useRemoteItems ? remoteTotal : localItems.filter((item) => !item.archived).length}</em>
                </span>
            ),
        },
        ...(hasPluginSource
            ? [
                  {
                      key: "plugin",
                      icon: <Puzzle aria-hidden="true" />,
                      label: (
                          <span className="asset-picker-source-menu-label">
                              <span>插件来源</span>
                              <em>{pluginItems.length}</em>
                          </span>
                      ),
                  },
              ]
            : []),
    ];
    const activeUpload = source === "plugin" ? upload?.external : upload;
    const uploading = uploadingCount > 0;

    return (
        <AppModal
            centered
            open={open}
            footer={null}
            title={null}
            destroyOnHidden
            closable={!working}
            mask={{ closable: !working }}
            keyboard={!working}
            onCancel={() => {
                if (!working) onClose();
            }}
            className="workspace-modal workspace-modal-wide asset-library-picker-modal"
            flush
        >
            <div className="asset-picker-shell">
                <header className="asset-picker-toolbar">
                    <div className="asset-picker-heading">
                        <div className="asset-picker-heading-copy">
                            <span>{eyebrow}</span>
                            <Dropdown
                                trigger={["click"]}
                                placement="bottomLeft"
                                rootClassName="asset-picker-source-dropdown"
                                onOpenChange={setSourceMenuOpen}
                                menu={{
                                    selectedKeys: [source],
                                    items: sourceMenuItems,
                                    onClick: ({ key }) => {
                                        if (key === "local" || key === "plugin") selectSource(key);
                                    },
                                }}
                            >
                                <button type="button" className="asset-picker-title-trigger" aria-haspopup="menu" aria-expanded={sourceMenuOpen} aria-label={"素材库来源：" + sourceLabel}>
                                    <strong>{title}</strong>
                                    <ChevronDown aria-hidden="true" />
                                </button>
                            </Dropdown>
                        </div>
                    </div>
                    <label className="asset-picker-search">
                        <Search aria-hidden />
                        <input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索素材名称或标签" aria-label="搜索素材" />
                    </label>
                    <span className="asset-picker-count">
                        已选 {selectedIds.length} · {effectivePagination ? effectivePagination.total : visibleItems.length} 个素材
                    </span>
                </header>
                <div className="asset-picker-body">
                    <nav className="asset-picker-categories" aria-label="素材分类">
                        {mediaKindOptions.length > 1 ? (
                            <>
                                <span className="asset-picker-nav-label">媒体类型</span>
                                {(["all", ...mediaKindOptions] as const).map((value) => (
                                    <button key={value} type="button" className={cn("assets-filter-item", mediaKind === value && "is-active")} aria-pressed={mediaKind === value} onClick={() => setMediaKind(value)}>
                                        <span className="assets-filter-item-label">{value === "all" ? "全部类型" : ASSET_PICKER_MEDIA_KIND_LABELS[value]}</span>
                                    </button>
                                ))}
                            </>
                        ) : null}
                        {sourceFolders.length ? (
                            <>
                                <span className="asset-picker-nav-label">文件夹</span>
                                <button type="button" className={cn("assets-filter-item", folderId === "all" && "is-active")} aria-pressed={folderId === "all"} onClick={() => setFolderId("all")}>
                                    <span className="assets-filter-item-label">全部文件夹</span>
                                    <span className="assets-filter-count">{sourceItems.length}</span>
                                </button>
                                {renderPickerFolders(sourceFolders, activeSourceItems, folderId, setFolderId)}
                            </>
                        ) : null}
                        {showCategories ? (
                            <>
                                <span className="asset-picker-nav-label">分类</span>
                                {normalCategories.map((value) => (
                                    <button key={value} type="button" className={cn("assets-filter-item", category === value && "is-active")} aria-pressed={category === value} onClick={() => setCategory(value)}>
                                        <span className="assets-filter-item-label">{categoryLabels[value] || (value === "all" ? "全部素材" : "其他")}</span>
                                        <span className="assets-filter-count">{countFor(value)}</span>
                                    </button>
                                ))}
                            </>
                        ) : null}
                    </nav>
                    <div className="asset-picker-grid-wrap">
                        <div className="asset-picker-grid">
                            {remoteEnabled && remoteQuery.isError ? (
                                <div className="asset-picker-empty" role="alert">
                                    <strong>素材读取失败</strong>
                                    <span>请稍后重试。</span>
                                    <Button onClick={() => void remoteQuery.refetch()}>重试</Button>
                                </div>
                            ) : loading || (remoteEnabled && !remoteQuery.isSuccess) ? (
                                <div className="asset-picker-empty">
                                    <LoaderCircle className="animate-spin" />
                                    <strong>正在读取素材</strong>
                                    <span>正在加载已保存的素材。</span>
                                </div>
                            ) : visibleItems.length ? (
                                visibleItems.map((item) => <PickerCard key={item.id} item={item} selected={selected.has(item.id)} onToggle={() => toggle(item)} />)
                            ) : (
                                <div className="asset-picker-empty">
                                    <FolderOpen />
                                    <strong>{emptyTitle}</strong>
                                    <span>{activeUpload ? "换个分类，或从底部上传一份新素材。" : emptyDescription}</span>
                                </div>
                            )}
                        </div>
                        {effectivePagination ? <PaginationBar alwaysShow current={effectivePagination.current} pageSize={effectivePagination.pageSize} total={effectivePagination.total} itemLabel="项" pageSizeOptions={[20, 40, 80]} onChange={effectivePagination.onChange} /> : null}
                    </div>
                </div>
                <footer className={cn("asset-picker-footer", !activeUpload && "is-compact")}>
                    {activeUpload ? (
                        <>
                            <input ref={uploadInputRef} type="file" hidden accept={activeUpload.accept} multiple={multiple} onChange={(event) => void handleUpload(event.target.files)} />
                            <button type="button" className="asset-picker-upload" onClick={() => uploadInputRef.current?.click()} disabled={working} aria-busy={uploading}>
                                {uploading ? <LoaderCircle className="animate-spin" /> : <Upload />}
                                <span>
                                    <strong>{uploading ? `正在上传 ${uploadingCount} 个素材` : "上传新素材"}</strong>
                                    <small>{uploading ? "保存完成后会自动选中" : activeUpload.description}</small>
                                </span>
                            </button>
                        </>
                    ) : footerNote ? (
                        <span className="asset-picker-footer-note">{footerNote}</span>
                    ) : (
                        <span />
                    )}
                    {error ? (
                        <span className="asset-picker-footer-error" role="alert">
                            {error}
                        </span>
                    ) : null}
                    <div className="asset-picker-actions">
                        <>
                            {onFolderAction && folderId !== "all" && (folderActionSource !== "local" || source === "local") ? (
                                <Button type="text" icon={<FolderOpen />} disabled={working} onClick={() => void runFolderAction()}>
                                    {folderActionLabel}
                                </Button>
                            ) : null}
                            <Button type="text" onClick={onClose} disabled={working}>
                                取消
                            </Button>
                            <Button type="primary" icon={<Check />} disabled={working || !selectedIds.length} loading={working && !uploading} onClick={() => void confirm()}>
                                {confirmLabel(selectedIds.length)}
                            </Button>
                        </>
                    </div>
                </footer>
            </div>
        </AppModal>
    );
}

// 角色卡、3D 模型等非媒体条目没有媒体类型，媒体筛选生效时不参与匹配。
export function pickerItemMediaKind(item: AssetLibraryPickerItem): AssetPickerMediaKind | undefined {
    if (item.mediaKind) return item.mediaKind;
    const kind = item.external?.item.kind || item.asset?.kind;
    return kind === "image" || kind === "video" || kind === "audio" || kind === "text" ? kind : undefined;
}

function pickerAssetMediaKind(asset: Asset): AssetPickerMediaKind | undefined {
    return asset.kind === "image" || asset.kind === "video" || asset.kind === "audio" || asset.kind === "text" ? asset.kind : undefined;
}

/** Empty parent items must not disable a SQLite asset that matches the picker media constraint. */
export function workspaceAssetPickerDisabledReason(
    asset: Asset,
    items: AssetLibraryPickerItem[],
    mediaKinds: AssetPickerMediaKind[] = DEFAULT_MEDIA_KINDS,
    remoteKind?: string,
) {
    const parent = items.find((item) => item.id === asset.id);
    if (parent) return parent.disabledReason;
    const mediaKind = pickerAssetMediaKind(asset);
    if (remoteKind && mediaKind !== remoteKind) return "此素材不适用于当前操作";
    if (mediaKind && mediaKinds.length > 0 && !mediaKinds.includes(mediaKind)) return "此素材不适用于当前操作";
    if (!mediaKind && (Boolean(remoteKind) || mediaKinds.length > 0)) return "此素材不适用于当前操作";
    return undefined;
}

function resolvePickerCatalogItem(id: string, localItems: AssetLibraryPickerItem[], remoteItems: AssetLibraryPickerItem[]) {
    return remoteItems.find((item) => item.id === id) || localItems.find((item) => item.id === id);
}

function PickerCard({ item, selected, onToggle }: { item: AssetLibraryPickerItem; selected: boolean; onToggle: () => void }) {
    const disabled = Boolean(item.disabledReason);
    return (
        <AssetLibraryCard selected={selected} className={cn("asset-picker-card", disabled && "is-disabled")}>
            <button type="button" className="asset-picker-card-action" onClick={onToggle} disabled={disabled} aria-pressed={selected} title={item.disabledReason || item.title}>
                <div className="assets-cover asset-picker-card-media">
                    {item.imageUrl || item.imageStorageKey ? (
                        <CachedResourceImage
                            storageKey={item.imageStorageKey}
                            src={item.imageUrl}
                            alt={item.title}
                            loading="lazy"
                            decoding="async"
                            className={item.imageFit === "contain" ? "is-contain" : undefined}
                            fallback={<div className="assets-cover-fallback">{kindIcon(item.kindLabel)}</div>}
                        />
                    ) : (
                        <AssetMediaPreview asset={item.asset} alt={item.title} fallback={<div className="assets-cover-fallback">{kindIcon(item.kindLabel)}</div>} />
                    )}
                    <span className="assets-cover-vignette" aria-hidden="true" />
                    <span className="assets-cover-badges" aria-hidden="true">
                        <span className="assets-cover-badge is-kind">{item.kindLabel}</span>
                    </span>
                    <span className="asset-picker-card-check" aria-hidden="true">
                        <Check />
                    </span>
                    {item.disabledReason ? <span className="asset-picker-card-lock">{item.disabledReason}</span> : null}
                </div>
                <div className="asset-picker-card-copy">
                    <strong>{item.title || "未命名素材"}</strong>
                    {item.description ? <span>{item.description}</span> : null}
                    {item.asset && isUnsavedWorkspaceAsset(item.asset) ? <span>未保存</span> : null}
                </div>
            </button>
        </AssetLibraryCard>
    );
}

function renderPickerFolders(folders: AssetLibraryPickerFolder[], items: AssetLibraryPickerItem[], selectedId: string, onSelect: (folderId: string) => void, parentId = "", depth = 0, visited: ReadonlySet<string> = new Set()): ReactNode {
    if (depth >= 8) return null;
    return folders
        .filter((folder) => (folder.parentId || "") === parentId && !visited.has(folder.id))
        .map((folder) => {
            const nextVisited = new Set(visited).add(folder.id);
            return (
                <span key={folder.id} className="contents">
                    <button
                        type="button"
                        className={cn("assets-filter-item", selectedId === folder.id && "is-active")}
                        aria-pressed={selectedId === folder.id}
                        onClick={() => onSelect(folder.id)}
                        style={{ paddingLeft: `calc(var(--space-3) + ${depth} * var(--space-3))` }}
                    >
                        <span className="assets-filter-item-label" title={folder.name}>
                            {folder.name}
                        </span>
                        <span className="assets-filter-count">{items.filter((item) => item.folderId === folder.id).length}</span>
                    </button>
                    {renderPickerFolders(folders, items, selectedId, onSelect, folder.id, depth + 1, nextVisited)}
                </span>
            );
        });
}

function kindIcon(label: string): ReactNode {
    if (label.includes("角色")) return <UserRound />;
    if (label.includes("视频")) return <Video />;
    if (label.includes("音频")) return <Music2 />;
    if (label.includes("文本")) return <FileText />;
    return <ImageIcon />;
}
