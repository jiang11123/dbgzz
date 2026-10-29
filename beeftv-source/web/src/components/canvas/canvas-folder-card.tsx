import { App, Dropdown, Input } from "antd";
import { LoaderCircle, MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent } from "react";

import { ProjectPreview } from "@/components/canvas/canvas-project-card";
import { LibraryCardShell } from "@/components/canvas/library-card-shell";
import { flushCanvasStorePersistence, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import type { CanvasLibrarySummary } from "@/services/api/workspace-data";
import { hasRemoteUserDataSyncSession, loadCanvasProjectForEditing, saveRemoteUserDataNow } from "@/services/local-workspace-sync";
import { useCanvasUiStore } from "@/stores/canvas/use-canvas-ui-store";
import { cn } from "@/lib/utils";

type CanvasFolderCardProps = {
    project: CanvasLibrarySummary;
    projectName?: string;
    folders?: Array<{ id: string; name: string }>;
    onMoveToFolder?: (folderId?: string) => void;
    onDuplicate?: () => Promise<void>;
    onDelete?: () => void;
    onClick: () => void;
    onPrefetch?: () => void;
    opening?: boolean;
};

/** 画布库中的文件夹封面：单一卡片表面承载预览和信息，避免相邻卡片互相侵入。 */
export function CanvasFolderCard({ project, projectName, folders = [], onMoveToFolder, onDuplicate, onDelete, onClick, onPrefetch, opening = false }: CanvasFolderCardProps) {
    const { message } = App.useApp();
    const renameProject = useCanvasStore((state) => state.renameProject);
    const selectedIds = useCanvasUiStore((state) => state.selectedProjectIds);
    const editingId = useCanvasUiStore((state) => state.editingProjectId);
    const editingTitle = useCanvasUiStore((state) => state.editingProjectTitle);
    const startEditing = useCanvasUiStore((state) => state.startEditingProject);
    const setEditingTitle = useCanvasUiStore((state) => state.setEditingProjectTitle);
    const stopEditing = useCanvasUiStore((state) => state.stopEditingProject);
    const toggleSelected = useCanvasUiStore((state) => state.toggleSelectedProjectId);
    const setDeleteIds = useCanvasUiStore((state) => state.setDeleteProjectIds);
    const editing = editingId === project.id;
    const selected = selectedIds.includes(project.id);
    const coverInputRef = useRef<HTMLInputElement>(null);
    const [coverUrl, setCoverUrl] = useState<string>();

    useEffect(() => {
        try { setCoverUrl(localStorage.getItem(`beeftv-project-cover:${project.id}`) || undefined); } catch { /* private browsing */ }
    }, [project.id]);

    const changeCover = (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) return;
        if (!file.type.startsWith("image/")) { message.error("封面请选择图片文件"); return; }
        if (file.size > 12 * 1024 * 1024) { message.error("封面图片不能超过 12 MB"); return; }
        const reader = new FileReader();
        reader.onload = () => {
            const image = new Image();
            image.onload = () => {
                const scale = Math.min(1, 1280 / Math.max(image.width, image.height));
                const canvas = document.createElement("canvas");
                canvas.width = Math.max(1, Math.round(image.width * scale));
                canvas.height = Math.max(1, Math.round(image.height * scale));
                canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
                const dataUrl = canvas.toDataURL("image/jpeg", 0.84);
                setCoverUrl(dataUrl);
                try { localStorage.setItem(`beeftv-project-cover:${project.id}`, dataUrl); } catch { /* quota */ }
                message.success("项目封面已更新");
            };
            image.src = String(reader.result);
        };
        reader.readAsDataURL(file);
    };

    const saveTitle = async () => {
        if (!editing) return;
        stopEditing();
        try {
            await loadCanvasProjectForEditing(project.id);
            renameProject(project.id, editingTitle);
            await flushCanvasStorePersistence();
            if (hasRemoteUserDataSyncSession()) await saveRemoteUserDataNow();
        } catch (error) { message.error(error instanceof Error ? error.message : "重命名失败"); }
    };

    return (
        <LibraryCardShell
            ariaLabel={`打开画布 ${project.title}`}
            onboardingProjectId={project.id}
            className={cn("canvas-collection-card", selected && "is-selected", editing && "is-editing", opening && "is-opening")}
            updatedAt={project.updatedAt}
            onOpen={onClick}
            openDisabled={editing || opening}
            onPointerEnter={onPrefetch}
            onPointerDown={onPrefetch}
            onFocusCapture={onPrefetch}
            cover={
                <div className="canvas-collection-preview-content">
                    <ProjectPreview project={{ id: project.id, nodes: project.previewNodes }} emptyVariant="libtv" />
                    {coverUrl ? <img className="canvas-collection-custom-cover" src={coverUrl} alt="" /> : null}
                    {opening ? <div className="canvas-collection-opening"><LoaderCircle className="size-5 animate-spin" /><span>正在打开</span></div> : null}
                </div>
            }
            title={editing ? (
                <Input
                    className="canvas-collection-title-input"
                    value={editingTitle}
                    onChange={(event) => setEditingTitle(event.target.value)}
                    onClick={(event) => event.stopPropagation()}
                    onBlur={saveTitle}
                    onKeyDown={(event) => {
                        if (event.key === "Enter") saveTitle();
                        if (event.key === "Escape") stopEditing();
                    }}
                    autoFocus
                />
            ) : project.title}
            actions={<>
                <span className={cn("canvas-collection-select", selected && "is-visible")} onClick={(event) => event.stopPropagation()}>
                <input
                    type="checkbox"
                    checked={selected}
                    onChange={(event) => toggleSelected(project.id, event.target.checked)}
                    aria-label={`选择 ${project.title}`}
                />
                </span>

                <div className="canvas-collection-actions" onClick={(event) => event.stopPropagation()}>
                <Dropdown
                    trigger={["click"]}
                    placement="bottomRight"
                    overlayClassName="project-library-menu"
                    menu={{
                        onClick: ({ domEvent }) => domEvent.stopPropagation(),
                        items: [
                            { key: "open", label: "打开", onClick: onClick },
                            { key: "rename", label: "重命名", onClick: () => startEditing(project.id, project.title) },
                            { key: "cover", label: "修改封面", onClick: () => coverInputRef.current?.click() },
                            { key: "duplicate", label: "创建副本", onClick: () => void onDuplicate?.() },
                            { key: "move", label: "移动至文件夹", children: [{ key: "root", label: "未分类", onClick: () => onMoveToFolder?.(undefined) }, ...folders.map((folder) => ({ key: folder.id, label: folder.name, onClick: () => onMoveToFolder?.(folder.id) }))] },
                            { type: "divider" },
                            { key: "delete", danger: true, label: "删除项目", onClick: () => onDelete?.() },
                        ],
                    }}
                >
                    <button type="button" className="product-icon-button canvas-collection-more" aria-label={`${project.title} 画布操作`} title="更多操作" onClick={(event) => event.stopPropagation()}>
                        <MoreHorizontal />
                    </button>
                </Dropdown>
                </div>
                <input ref={coverInputRef} type="file" accept="image/*" className="hidden" onChange={changeCover} />
            </>}
        />
    );
}
