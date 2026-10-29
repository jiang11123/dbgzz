import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ChangeEvent } from "react";
import { getCanvasHydrationHealth,subscribeCanvasHydrationHealth } from "@/services/canvas-hydration-health";
import { useNavigate, useSearchParams } from "react-router";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { App, Button, Dropdown, Input, Modal } from "antd";
import { Select } from "@/components/ui/base/select";
import { Download, FolderPlus, Image as ImageIcon, MoreHorizontal, Pencil, Plus, Trash2, Upload } from "lucide-react";

import { CollectionGrid, PageHeader, WorkspacePage } from "@/components/layout/workspace-page";
import { ExpandableSearch } from "@/components/layout/expandable-search";
import { WorkspaceLoadingState, WorkspaceState } from "@/components/layout/workspace-state";

import { CanvasFolderCard } from "@/components/canvas/canvas-folder-card";
import { CanvasDeleteConfirmation } from "@/components/canvas/canvas-delete-confirmation";
import { RecycleBinDialog } from "@/components/canvas/recycle-bin-dialog";
import { LibraryCardShell } from "@/components/canvas/library-card-shell";
import { flushCanvasStorePersistence, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useCanvasUiStore } from "@/stores/canvas/use-canvas-ui-store";
import { awaitCanvasExportStep, canvasExportProgressLabel, exportCanvasProjects, type CanvasExportProgress } from "@/lib/canvas/canvas-export";
import { restoreCanvasArchive } from "@/lib/canvas/canvas-archive-restore";
import { createCanvasLibraryFolder, deleteCanvasLibraryFolder, hydrateCanvasLibraryFolders, persistCanvasFolderCover, renameCanvasLibraryFolder } from "@/lib/canvas/canvas-folder-storage";
import { isWailsNativeShell } from "@/services/desktop-media-save";
import { loadCanvasProjectForEditing, saveRemoteUserDataNow } from "@/services/local-workspace-sync";
import { isLocalWorkspaceMode } from "@/services/workspace-mode";
import { usesBrowserLocalResourceStore } from "@/services/workspace-resource-storage";
import { beginLocalCanvasProject, deleteLocalCanvasProjects, hydrateLocalCanvasProjectsFromBackend, syncLocalCanvasProjectToBackend } from "@/services/local-workspace-repository";
import { createWorkspaceCanvasProject } from "@/services/workspace-project-repository";
import { listWorkspaceCanvasProjectsPage, type CanvasLibrarySummary } from "@/services/api/workspace-data";
import { useUserStore } from "@/stores/use-user-store";
import { listProjects } from "@/services/api/projects";
import { loadCanvasProjectPage } from "@/lib/workspace-route-modules";
import { useSyncProgressStore } from "@/stores/use-sync-progress-store";
import { useAppearanceStore } from "@/stores/use-appearance-store";
import { cn } from "@/lib/utils";
import { assertUserScope, captureUserScope, type CapturedUserScope } from "@/lib/user-scope-guard";
import { recordDiagnosticEvent } from "@/services/diagnostics/client-diagnostics";
import { canvasIdsForWorkspaceProjects, canvasWorkspaceProjectId, listCanvasWorkspaceProjectCanvases, listCanvasWorkspaceProjectRoots, previewNodesForWorkspaceProject } from "@/lib/canvas/canvas-workspace-project";

const CanvasDeleteProjectsDialog = lazy(() => import("@/components/canvas/canvas-delete-projects-dialog").then((module) => ({ default: module.CanvasDeleteProjectsDialog })));

export default function CanvasPage() {
    const canvasHealth = useSyncExternalStore(subscribeCanvasHydrationHealth,getCanvasHydrationHealth);
    const { message } = App.useApp();
    const brandName = useAppearanceStore((state) => state.appearance.brandName);
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const inputRef = useRef<HTMLInputElement>(null);
    const autoOpenRef = useRef(false);
    const [keyword, setKeyword] = useState("");
    const [sort, setSort] = useState<"updated" | "name" | "nodes">("updated");
    const [projectFilter, setProjectFilter] = useState("all");
    const [folderFilter, setFolderFilter] = useState("all");
    const [folderDialogOpen, setFolderDialogOpen] = useState(false);
    const [folderName, setFolderName] = useState("");
    const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
    const [deletingFolder, setDeletingFolder] = useState<{ id: string; name: string; scope: CapturedUserScope } | null>(null);
    const loadMoreRef = useRef<HTMLDivElement>(null);
    const [loadedProjectCount, setLoadedProjectCount] = useState(50);
    const [creationError, setCreationError] = useState(false);
    const exportController = useRef<AbortController | null>(null);
    const [exportProgress, setExportProgress] = useState<CanvasExportProgress | null>(null);
    const [exportError, setExportError] = useState("");
    useEffect(() => () => exportController.current?.abort(), []);
    const hydrated = useCanvasStore((state) => state.hydrated);
    const localProjects = useCanvasStore((state) => state.projects);
    const folders = useCanvasStore((state) => state.folders);
    const moveProjectsToFolder = useCanvasStore((state) => state.moveProjectsToFolder);
    const userId = useUserStore((state) => state.user?.id);
    const sessionHydrated = useUserStore((state) => state.hydrated);
    // The sync layer is the source of truth: it also recognizes the synthetic
    // local identity, which protects the library from stale session state after
    // a desktop reload or HMR cycle.
    // The default BeefTV build is local-only even when a stale/embedded browser
    // session still contains a logged-in user. Cloud project APIs are opt-in via
    // the explicit hosted build flag, never inferred from login state.
    const remoteMode = import.meta.env.VITE_CANVAS_LOCAL_MODE === "false" && Boolean(userId) && !isLocalWorkspaceMode();
    useEffect(() => {
        if (!hydrated || !isLocalWorkspaceMode()) return;
        void hydrateLocalCanvasProjectsFromBackend();
        void hydrateCanvasLibraryFolders().catch((error) => {
            message.error(error instanceof Error ? error.message : "文件夹列表读取失败");
        });
    }, [hydrated, message]);
    const [debouncedKeyword, setDebouncedKeyword] = useState("");
    useEffect(() => {
        const timer = window.setTimeout(() => setDebouncedKeyword(keyword.trim()), 250);
        return () => window.clearTimeout(timer);
    }, [keyword]);
    const libraryQuery = useInfiniteQuery({
        queryKey: ["canvas-library", userId, projectFilter, sort, debouncedKeyword],
        queryFn: ({ pageParam, signal }) => listWorkspaceCanvasProjectsPage({ page: pageParam, pageSize: 40, projectId: projectFilter, sort, query: debouncedKeyword, signal }),
        initialPageParam: 1,
        getNextPageParam: (last) => last.hasMore ? last.page + 1 : undefined,
        enabled: remoteMode && sessionHydrated,
    });
    const projects = useMemo<CanvasLibrarySummary[]>(() => remoteMode
        ? libraryQuery.data?.pages.flatMap((page) => page.projects) || []
        : listCanvasWorkspaceProjectRoots(localProjects).map((project) => ({ ...project, nodeCount: project.nodes.length, previewNodes: previewNodesForWorkspaceProject(localProjects, canvasWorkspaceProjectId(project)) })), [libraryQuery.data, localProjects, remoteMode]);
    const totalProjects = remoteMode ? libraryQuery.data?.pages[0]?.total || 0 : projects.length;
    const selectedIds = useCanvasUiStore((state) => state.selectedProjectIds);
    const deleteDialogOpen = useCanvasUiStore((state) => state.deleteProjectIds.length > 0);
    const setDeleteIds = useCanvasUiStore((state) => state.setDeleteProjectIds);
    const deleteSelectedProjects = () => {
        setDeleteIds(selectedCanvasIds);
    };
    const updateProject = useCanvasStore((state) => state.updateProject);
    const [historyOpen, setHistoryOpen] = useState(() => searchParams.get("history") === "all" || searchParams.get("history") === "deleted");
    const [associationOpen, setAssociationOpen] = useState(false);
    const [associationProjectId, setAssociationProjectId] = useState("");
    // 本地工作区的画布、文件夹与历史完全来自浏览器本地存储；项目关系查询只在远程工作区启用。
    const projectQuery = useQuery({ queryKey: ["projects", userId], queryFn: () => listProjects(), enabled: remoteMode && sessionHydrated });

    const mode = searchParams.get("mode");
    const agentMode = mode === "new" || mode === "recent" || mode === "choose";
    const handoffMode = mode === "handoff";
    const forwardedQuery = agentMode || handoffMode || searchParams.get("agent") === "1" ? `?${searchParams.toString()}` : "";
    const preloadProject = useCallback(() => {
        void loadCanvasProjectPage();
    }, []);
    const enterProject = useCallback(
        (id: string) => {
            preloadProject();
            navigate(`/canvas/${id}${forwardedQuery}`);
        },
        [forwardedQuery, navigate, preloadProject],
    );
    const createAndEnter = () => {
        setCreationError(false);
        const { id, saved } = beginLocalCanvasProject("未命名项目");
        void saved.then(() => {
            // Only enter after the desktop repository has accepted the new canvas.
            if (searchParams.get("stay") !== "1") enterProject(id);
        }).catch((error) => {
            setCreationError(true);
            message.error(error instanceof Error ? error.message : "创建项目失败，请重试");
        });
    };
    const duplicateCanvasProject = useCallback(async (project: CanvasLibrarySummary) => {
        if (!remoteMode) {
            const sourceCanvases = listCanvasWorkspaceProjectCanvases(localProjects, project.id);
            let copiedWorkspaceProjectId: string | undefined;
            for (const [index, source] of sourceCanvases.entries()) {
                const copy = await createWorkspaceCanvasProject(index === 0 ? `${project.title || "未命名项目"} 副本` : source.title, source.projectId, {
                    nodes: source.nodes,
                    connections: source.connections,
                    chatSessions: source.chatSessions,
                    activeChatId: source.activeChatId,
                }, copiedWorkspaceProjectId);
                copiedWorkspaceProjectId ||= copy.id;
            }
            if (!copiedWorkspaceProjectId) throw new Error("项目不存在");
            message.success(`项目副本已创建，共 ${sourceCanvases.length} 张画布`);
            enterProject(copiedWorkspaceProjectId);
            return;
        }
        const source = await loadCanvasProjectForEditing(project.id);
        if (!source) throw new Error("画布不存在");
        const copy = await createWorkspaceCanvasProject(`${source.title || project.title || "未命名项目"} 副本`, undefined, {
            nodes: source.nodes,
            connections: source.connections,
            chatSessions: source.chatSessions,
            activeChatId: source.activeChatId,
        });
        message.success("项目副本已创建");
        enterProject(copy.id);
    }, [enterProject, localProjects, message, remoteMode]);
    const filteredProjects = useMemo(() => {
        if (remoteMode) return projects;
        const query = keyword.trim().toLowerCase();
        // The root library represents uncategorized work alongside folder tiles.
        // Categorized projects must disappear from the root after being moved and
        // only reappear when their folder is opened.
        const scoped = projects.filter((project) => (projectFilter === "all" || (projectFilter === "independent" ? !project.projectId : project.projectId === projectFilter)) && (folderFilter === "all" ? !project.folderId : project.folderId === folderFilter));
        const values = query ? scoped.filter((project) => project.title.toLowerCase().includes(query)) : [...scoped];
        values.sort((a, b) => (sort === "name" ? a.title.localeCompare(b.title, "zh-CN") : sort === "nodes" ? b.nodeCount - a.nodeCount : new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()));
        return values;
    }, [folderFilter, keyword, projectFilter, projects, remoteMode, sort]);
    const projectNames = useMemo(() => new Map((projectQuery.data?.projects || []).map(({ project }) => [project.id, project.name])), [projectQuery.data]);
    const visibleProjects = remoteMode ? filteredProjects : filteredProjects.slice(0, loadedProjectCount);
    const hasMore = remoteMode ? libraryQuery.hasNextPage : visibleProjects.length < filteredProjects.length;
    const selectedProjects = projects.filter((project) => selectedIds.includes(project.id));
    const selectedCanvasIds = remoteMode ? selectedIds : canvasIdsForWorkspaceProjects(localProjects, selectedIds);
    // Folder tiles belong to the root library only. Once a folder is opened,
    // the grid represents that folder's contents; rendering the active folder
    // tile again makes an empty folder look like it contains itself.
    const visibleFolders = folderFilter === "all" ? folders : [];
    const activeFolder = folderFilter === "all" ? undefined : folders.find((folder) => folder.id === folderFilter);
    const projectFilterItems = useMemo(() => [{ key: "all", label: "全部画布" }, { key: "independent", label: "自由画布" }, ...(projectQuery.data?.projects || []).map(({ project }) => ({ key: project.id, label: project.name }))], [projectQuery.data]);
    const saveFolderRename = () => {
        const nextName = folderName.trim() || "未命名文件夹";
        const id = editingFolderId;
        setFolderName("");
        setEditingFolderId(null);
        setFolderDialogOpen(false);
        if (!id) return;
        void renameCanvasLibraryFolder(id, nextName).catch((error) => {
            message.error(error instanceof Error ? error.message : "文件夹没有保存成功");
        });
    };
    useEffect(() => {
        setLoadedProjectCount(50);
    }, [folderFilter, keyword, projectFilter, sort]);
    useEffect(() => {
        const node = loadMoreRef.current;
        if (!node || !hasMore) return;
        const observer = new IntersectionObserver(
            ([entry]) => {
                if (!entry?.isIntersecting) return;
                if (remoteMode) {
                    if (!libraryQuery.isFetchingNextPage && !libraryQuery.isFetchNextPageError) void libraryQuery.fetchNextPage();
                } else setLoadedProjectCount((count) => Math.min(count + 50, filteredProjects.length));
            },
            { rootMargin: "600px" },
        );
        observer.observe(node);
        return () => observer.disconnect();
    }, [filteredProjects.length, visibleProjects.length, hasMore, remoteMode, libraryQuery.fetchNextPage, libraryQuery.isFetchingNextPage, libraryQuery.isFetchNextPageError]);
    const associateSelected = async (nextProjectId = associationProjectId) => {
        const projectId = nextProjectId || undefined;
        try {
            for (const id of selectedIds) await loadCanvasProjectForEditing(id);
            selectedIds.forEach((id) => updateProject(id, { projectId }));
            if (remoteMode) await saveRemoteUserDataNow();
            message.success(projectId ? "已加入项目" : "已移出项目，画布仍保留");
            setAssociationOpen(false);
        } catch (error) {
            message.error(error instanceof Error ? `画布关系保存失败：${error.message}` : "画布关系保存失败");
        }
    };
    const exportSelected = async () => {
        if (exportController.current) return;
        const controller = new AbortController();
        exportController.current = controller;
        const scope = captureUserScope();
        setExportError("");
        setExportProgress({ phase: "loading" });
        try {
            const selected = [];
            for (const id of selectedCanvasIds) {
                const project = await awaitCanvasExportStep(loadCanvasProjectForEditing(id), controller.signal);
                controller.signal.throwIfAborted();
                assertUserScope(scope);
                if (!project) throw new Error("画布不存在，无法导出");
                selected.push(project);
            }
            const saved = await exportCanvasProjects(selected, `${brandName}画布-${selected.length}个画布`, { folders, signal: controller.signal, onProgress: setExportProgress });
            if (saved === "saved" && isWailsNativeShell()) message.success("已保存到所选位置");
        } catch (error) {
            if (controller.signal.aborted) {
                recordDiagnosticEvent({ category: "action", level: "info", code: "canvas_export_cancelled", message: "已取消画布导出" });
            } else {
                setExportError(error instanceof Error ? error.message : "导出失败，请重试");
                recordDiagnosticEvent({ category: "action", level: "error", code: "canvas_export_failed", message: "画布导出失败" });
            }
        } finally {
            exportController.current = null;
            setExportProgress(null);
        }
    };
    const importCanvas = async (file?: File) => {
        if (!file) return;
        const hideLoading = message.loading({ content: "正在解压并准备导入画布...", duration: 0 });
        try {
            const result = await restoreCanvasArchive(file, {
                onProjectProgress: (projectId, progress) => {
                    useSyncProgressStore.getState().setProjectProgress(projectId, progress);
                },
            });
            hideLoading();
            message.success(result.storage === "backend"
                ? `已导入 ${result.count} 个画布`
                : `已导入 ${result.count} 个画布并保存到本地`);
        } catch (error) {
            hideLoading();
            console.error("导入画布失败", error);
            message.error(error instanceof Error ? `导入失败：${error.message}` : "导入失败，请选择有效的画布压缩包");
        } finally {
            if (inputRef.current) inputRef.current.value = "";
        }
    };

    useEffect(() => {
        // Local desktop canvases do not depend on a browser login session. Waiting
        // for session hydration here can leave /canvas?mode=new on the opening
        // screen forever after an app restart, even though the local store is
        // already ready. Hosted mode still waits for both session and library.
        if (!hydrated || (remoteMode && (!sessionHydrated || !libraryQuery.isSuccess)) || autoOpenRef.current || (mode !== "new" && mode !== "recent" && mode !== "handoff")) return;
        // A new local canvas can be created while older projects are still
        // hydrating. Waiting for every historical canvas leaves this route on
        // the loading screen when one large project or cache write is slow.
        if (!remoteMode && mode !== "new" && (canvasHealth.loading || canvasHealth.error)) return;
        autoOpenRef.current = true;
        if (mode === "recent" && projects[0]?.id) {
            enterProject(projects[0].id);
            return;
        }
        const { id, saved } = beginLocalCanvasProject("未命名项目");
        void saved.then(() => enterProject(id)).catch((error) => {
            setCreationError(true);
            message.error(error instanceof Error ? error.message : "创建项目失败，请重试");
        });
    }, [hydrated, message, mode, projects, remoteMode, sessionHydrated, libraryQuery.isSuccess,canvasHealth]);

    if (!creationError && !libraryQuery.isError && !(canvasHealth.error && !remoteMode) && (mode === "new" || mode === "recent" || mode === "handoff")) return <main className="flex h-full items-center justify-center bg-background text-sm text-stone-500">正在打开画布...</main>;

    return (
        <WorkspacePage className="studio-collection-page lib-tv-project-page">
            <PageHeader
                title={activeFolder?.name || "全部项目"}
                leading={activeFolder ? <button type="button" className="libtv-project-breadcrumb-button" onClick={() => setFolderFilter("all")}>全部项目 /</button> : undefined}
                actions={(
                    <div className="libtv-project-actions">
                    <ExpandableSearch value={keyword} placeholder="搜索项目" onChange={setKeyword} />
                    <Button icon={<Upload />} disabled={!hydrated} onClick={() => inputRef.current?.click()}>导入画布</Button>
                    <Button icon={<Trash2 />} onClick={() => setHistoryOpen(true)}>回收站</Button>
                    <Button icon={<FolderPlus />} disabled={!hydrated} onClick={() => {
                        void createCanvasLibraryFolder("未命名文件夹").catch((error) => {
                            message.error(error instanceof Error ? error.message : "文件夹没有保存成功");
                        });
                    }}>新建文件夹</Button>
                    </div>
                )}
            />

            <div className="collection-content">
                {selectedIds.length || exportProgress ? (
                    <div className="collection-selection-bar">
                        <strong className="mr-auto font-medium">{exportProgress ? "正在导出画布" : `已选 ${selectedIds.length} 个项目`}</strong>
                        {remoteMode ? <>
                            <Button
                                size="small"
                                disabled={!hydrated || projectQuery.isLoading}
                                onClick={() => {
                                    setAssociationProjectId(selectedProjects[0]?.projectId || "");
                                    setAssociationOpen(true);
                                }}
                            >
                                加入项目
                            </Button>
                            {selectedProjects.some((project) => project.projectId) ? (
                                <Button
                                    size="small"
                                    disabled={!hydrated}
                                    onClick={() => {
                                        setAssociationProjectId("");
                                        void associateSelected("");
                                    }}
                                >
                                    移出项目
                                </Button>
                            ) : null}
                        </> : null}
                        <Button size="small" aria-label="导出" disabled={!hydrated} loading={Boolean(exportProgress)} icon={<Download className="size-3.5" />} onClick={() => void exportSelected()}>
                            导出
                        </Button>
                        {exportProgress ? <>
                            <span className="text-sm text-foreground/65" role="status" aria-live="polite">{canvasExportProgressLabel(exportProgress)}</span>
                            <Button size="small" disabled={exportProgress.phase === "saving"} onClick={() => exportController.current?.abort()}>取消导出</Button>
                        </> : null}
                        <Button size="small" danger disabled={!hydrated || Boolean(exportProgress)} onClick={deleteSelectedProjects}>
                            删除
                        </Button>
                    </div>
                ) : null}

                {exportError ? <p role="alert" className="mb-4 whitespace-pre-wrap break-words text-sm text-destructive">{exportError}</p> : null}

                {!remoteMode && canvasHealth.error ? <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 text-sm"><span>{canvasHealth.error}</span><Button loading={canvasHealth.loading} onClick={()=>void hydrateLocalCanvasProjectsFromBackend()}>重试加载</Button></div> : null}
                {remoteMode && libraryQuery.isError ? (
                    <div role="alert">画布列表读取失败<Button onClick={() => void libraryQuery.refetch()}>重试</Button></div>
                ) : !hydrated || (remoteMode && libraryQuery.isPending) ? (
                    <WorkspaceLoadingState label="正在恢复画布" detail="读取本地缓存与账号同步状态" />
                ) : visibleProjects.length || (!keyword && projectFilter === "all") ? (
                    <CollectionGrid className="canvas-collection-grid">
                        <div className="libtv-create-project-entry">
                            <article className="libtv-create-project-card" role="button" tabIndex={0} onClick={createAndEnter} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); createAndEnter(); } }}>
                                <div className="libtv-create-project-icon"><Plus /></div>
                                <strong>开始创作</strong>
                            </article>
                            <p className="libtv-create-project-subtitle">创建新的视频项目</p>
                        </div>
                        {visibleFolders.map((folder) => <CanvasLibraryFolderTile key={folder.id} folder={folder} onOpen={() => setFolderFilter(folder.id)} onRename={() => { setFolderName(folder.name); setEditingFolderId(folder.id); setFolderDialogOpen(true); }} onDelete={() => setDeletingFolder({ id: folder.id, name: folder.name, scope: captureUserScope() })} onCoverChange={(dataUrl) => {
                            void persistCanvasFolderCover(folder.id, dataUrl).then(() => {
                                message.success("文件夹封面已更新");
                            }).catch((error) => {
                                message.error(error instanceof Error ? error.message : "封面没有保存成功");
                            });
                        }} />)}
                        {visibleProjects.map((project) => (
                            <CanvasFolderCard
                                key={project.id}
                                project={project}
                                projectName={project.projectId ? projectNames.get(project.projectId) || "未同步项目" : undefined}
                                folders={folders}
                                onMoveToFolder={async (folderId) => {
                                    try {
                                        // Keep the menu action transactional: validate the selected
                                        // folder, update the local store, then verify the in-memory
                                        // relation before reporting success. This prevents a stale
                                        // menu/list state from making a failed move look successful.
                                        if (folderId && !folders.some((folder) => folder.id === folderId)) {
                                            throw new Error("目标文件夹不存在");
                                        }
                                        const projectCanvasIds = canvasIdsForWorkspaceProjects(localProjects, [project.id]);
                                        moveProjectsToFolder(projectCanvasIds, folderId);
                                        await flushCanvasStorePersistence();
                                        const movedProject = useCanvasStore.getState().projects.find((item) => item.id === project.id);
                                        if (!movedProject || (movedProject.folderId || undefined) !== (folderId || undefined)) {
                                            throw new Error("项目移动未完成，请重试");
                                        }
                                        if (!usesBrowserLocalResourceStore()) {
                                            await Promise.all(projectCanvasIds.map((id) => syncLocalCanvasProjectToBackend(id)));
                                        }
                                        message.success(folderId ? "已移动到文件夹" : "已移出文件夹");
                                    } catch (error) {
                                        message.error(error instanceof Error ? error.message : "移动项目失败");
                                    }
                                }}
                                onDuplicate={() => duplicateCanvasProject(project)}
                                onDelete={() => {
                                    setDeleteIds([project.id]);
                                }}
                                onClick={() => enterProject(project.id)}
                                onPrefetch={preloadProject}
                            />
                        ))}
                    </CollectionGrid>
                ) : (
                    <WorkspaceState icon="canvas" title={canvasHealth.error ? "项目暂时无法加载" : keyword || projectFilter !== "all" || folderFilter !== "all" ? "没有匹配的项目" : "让第一个想法落在画布上"} description={canvasHealth.error || (keyword || projectFilter !== "all" || folderFilter !== "all" ? "换一个名称或重置筛选条件。" : "图片、分镜和灵感，都可以在这里自由组织。")} action={canvasHealth.error ? <Button loading={canvasHealth.loading} onClick={()=>void hydrateLocalCanvasProjectsFromBackend()}>重试加载</Button> : !keyword && projectFilter === "all" && folderFilter === "all" ? <Button type="primary" icon={<Plus />} disabled={!hydrated} onClick={createAndEnter}>新建项目</Button> : undefined} />
                )}
                {hydrated && visibleProjects.length && (hasMore || libraryQuery.isFetchNextPageError) ? (
                    <div ref={loadMoreRef} className="library-load-more" aria-live="polite">
                        {libraryQuery.isFetchNextPageError ? <Button onClick={() => void libraryQuery.fetchNextPage()}>加载失败，重试</Button> : hasMore ? "继续下滑加载更多" : `已加载全部 ${filteredProjects.length} 个画布`}
                    </div>
                ) : null}
            </div>

            <input ref={inputRef} type="file" accept="application/zip,.zip" className="hidden" onChange={(event) => void importCanvas(event.target.files?.[0])} />
            <Modal
                className="libtv-folder-dialog"
                wrapClassName="libtv-folder-dialog-wrap"
                title="重命名文件夹"
                open={folderDialogOpen}
                okText="保存"
                okButtonProps={{ type: "default" }}
                cancelText="取消"
                onCancel={() => { setFolderDialogOpen(false); setEditingFolderId(null); setFolderName(""); }}
                onOk={saveFolderRename}
            >
                <Input autoFocus value={folderName} placeholder="例如：短片项目" onChange={(event) => setFolderName(event.target.value)} onPressEnter={saveFolderRename} />
            </Modal>
            <Modal
                title="加入项目"
                open={associationOpen}
                okText="保存关联"
                cancelText="取消"
                okButtonProps={{ disabled: !associationProjectId, loading: projectQuery.isFetching }}
                onCancel={() => setAssociationOpen(false)}
                onOk={() => void associateSelected()}
            >
                <p className="mb-3 text-sm text-foreground/60">选中的画布会保留原有节点和本地媒体，只增加项目关联。</p>
                <Select
                    className="w-full"
                    value={associationProjectId || undefined}
                    placeholder="选择项目"
                    options={(projectQuery.data?.projects || []).map((item) => ({ label: item.project.name, value: item.project.id }))}
                    onChange={setAssociationProjectId}
                />
            </Modal>
            <RecycleBinDialog open={historyOpen} onClose={() => setHistoryOpen(false)} />
            {deletingFolder ? <CanvasDeleteConfirmation scope={deletingFolder.scope} title={`删除文件夹「${deletingFolder.name}」？`}
                description={`将删除此文件夹及其中 ${localProjects.filter((project) => project.folderId === deletingFolder.id).length} 个画布，画布里的节点和连线也会一起移除。`}
                onCancel={() => setDeletingFolder(null)} onConfirm={async (assertCurrent) => {
                    const folderId = deletingFolder.id;
                    const ids = useCanvasStore.getState().projects.filter((project) => project.folderId === folderId).map((project) => project.id);
                    if (ids.length) await deleteLocalCanvasProjects(ids);
                    assertCurrent();
                    await deleteCanvasLibraryFolder(folderId);
                    assertCurrent();
                    message.success(ids.length ? `已删除文件夹及其中 ${ids.length} 个画布` : "文件夹已删除");
                }} /> : null}
            {deleteDialogOpen ? <Suspense fallback={null}><CanvasDeleteProjectsDialog /></Suspense> : null}
        </WorkspacePage>
    );
}

function CanvasLibraryFolderTile({ folder, onOpen, onRename, onDelete, onCoverChange }: { folder: { id: string; name: string; updatedAt: string; coverDataUrl?: string; unsaved?: boolean; saveError?: string }; onOpen: () => void; onRename: () => void; onDelete: () => void; onCoverChange: (dataUrl: string) => void }) {
    const { message } = App.useApp();
    const coverInputRef = useRef<HTMLInputElement>(null);
    const chooseCover = (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;
        if (!file.type.startsWith("image/")) { message.error("封面请选择图片文件"); return; }
        if (file.size > 12 * 1024 * 1024) { message.error("封面图片不能超过 12MB"); return; }
        const reader = new FileReader();
        reader.onload = () => {
            if (typeof reader.result !== "string") return;
            const image = new Image();
            image.onload = () => {
                const maxSize = 1280;
                const scale = Math.min(1, maxSize / Math.max(image.naturalWidth, image.naturalHeight));
                const canvas = document.createElement("canvas");
                canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
                canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
                canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
                onCoverChange(canvas.toDataURL("image/jpeg", 0.84));
            };
            image.src = reader.result;
        };
        reader.readAsDataURL(file);
        event.target.value = "";
    };
    return (
        <LibraryCardShell
            ariaLabel={`打开文件夹 ${folder.name}`}
            className="libtv-folder-card"
            updatedAt={folder.updatedAt}
            onOpen={onOpen}
            title={folder.saveError ? `${folder.name} · 保存失败` : folder.unsaved ? `${folder.name} · 未保存` : folder.name}
            cover={<div className={cn("libtv-folder-cover-art", folder.coverDataUrl && "has-custom-cover")} style={folder.coverDataUrl ? { backgroundImage: `url(${folder.coverDataUrl})`, backgroundSize: "cover", backgroundPosition: "center" } : undefined} />}
            actions={<>
                <Dropdown
                trigger={["click"]}
                placement="bottomRight"
                overlayClassName="project-library-menu folder-library-menu"
                menu={{
                    onClick: ({ domEvent }) => domEvent.stopPropagation(),
                    items: [
                        { key: "open", label: "打开", onClick: onOpen },
                        { key: "rename", label: "重命名", onClick: onRename },
                        { key: "cover", label: "更换封面", onClick: () => coverInputRef.current?.click() },
                        { type: "divider" },
                        { key: "delete", danger: true, label: "删除文件夹", onClick: onDelete },
                    ],
                }}
                >
                    <button type="button" className="product-icon-button libtv-folder-card-more" aria-label={`${folder.name} 文件夹操作`} title="更多操作" onClick={(event) => event.stopPropagation()}><MoreHorizontal /></button>
                </Dropdown>
                <input ref={coverInputRef} type="file" accept="image/*" className="hidden" onChange={chooseCover} />
            </>}
        />
    );
}
