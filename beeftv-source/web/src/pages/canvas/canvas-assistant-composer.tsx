import { Button, Select, Tooltip } from "antd";
import { ArrowUp, Square, X, Paperclip, Sparkles } from "lucide-react";
import { useRef, useState } from "react";

import { CanvasResourceMentionTextarea } from "@/components/canvas/canvas-resource-mention-textarea";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import type { AssistantPermissionMode } from "@/services/api/agent-assistant";
import { CanvasAssistantModelPicker } from "./canvas-assistant-model-picker";

const LINE_HEIGHT = 21;
const MIN_LINES = 3;
const MAX_LINES = 8;

type Props = {
    value: string;
    onChange: (value: string) => void;
    onSend: () => void;
    onStop: () => void;
    streaming: boolean;
    disabled: boolean;
    disabledReason?: string;
    references: CanvasResourceReference[];
    selectedCount: number;
    selectionAttached: boolean;
    onDetachSelection: () => void;
    modelBusy?: boolean;
    canSupplement?: boolean;
    supplementBusy?: boolean;
    hasAttachments?: boolean;
    inputBusy?: boolean;
    onFiles?: (files: File[]) => void;
    onOpenSkills?: () => void;
    onOpenReferences?: () => void;
    inputContent?: React.ReactNode;
    permissionMode?: AssistantPermissionMode;
    permissionLocked?: boolean;
    onPermissionChange?: (mode: AssistantPermissionMode) => void;
};

export function CanvasAssistantComposer({
    value,
    onChange,
    onSend,
    onStop,
    streaming,
    disabled,
    disabledReason,
    references,
    selectedCount,
    selectionAttached,
    onDetachSelection,
    modelBusy,
    canSupplement,
    supplementBusy,
    hasAttachments,
    inputBusy,
    onFiles,
    onOpenSkills,
    onOpenReferences,
    inputContent,
    permissionMode = "canvas",
    permissionLocked,
    onPermissionChange,
}: Props) {
    const [contentHeight, setContentHeight] = useState(LINE_HEIGHT);
    const fileInput = useRef<HTMLInputElement>(null);
    const height = Math.min(MAX_LINES * LINE_HEIGHT, Math.max(MIN_LINES * LINE_HEIGHT, contentHeight));
    const canSend = !disabled && (!streaming || canSupplement) && !supplementBusy && !inputBusy && (Boolean(value.trim()) || Boolean(hasAttachments));

    return (
        <footer className="canvas-assistant-composer" onDragOver={event => { if (onFiles && !disabled && event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.stopPropagation(); } }}
            onDrop={event => { if (onFiles && !disabled && event.dataTransfer.files.length) { event.preventDefault(); event.stopPropagation(); onFiles([...event.dataTransfer.files]); } }}
            onPasteCapture={event => { const files = [...event.clipboardData.files]; if (onFiles && !disabled && files.length) { event.preventDefault(); event.stopPropagation(); onFiles(files); const text = event.clipboardData.getData("text/plain"); if (text) onChange(value + text); } }}>
            <input ref={fileInput} type="file" accept="image/*,video/*,audio/*" multiple hidden aria-label="添加参考素材文件" onChange={event => { onFiles?.([...event.target.files || []]); event.target.value = ""; }} />
            {!streaming && selectionAttached && selectedCount > 0 ? <div className="canvas-assistant-chips">
                    <span className="canvas-assistant-chip">
                        已选 {selectedCount} 个节点
                        <button type="button" aria-label="这条消息不带已选节点" onClick={onDetachSelection}>
                            <X className="size-3" />
                        </button>
                    </span>
            </div> : null}

            {inputContent}

            <div className="canvas-assistant-input" style={{ height: height + 14 }}>
                <CanvasResourceMentionTextarea
                    value={value}
                    references={references}
                    onChange={onChange}
                    onSubmit={() => { if (canSend) onSend(); }}
                    includeAssetLibrary
                    containerClassName="h-full min-h-0"
                    className="thin-scrollbar h-full w-full resize-none overflow-y-auto border-none bg-transparent px-3 py-1.5 text-[var(--fs-caption)] leading-[21px] !shadow-none !outline-none !ring-0 focus:!shadow-none focus:!outline-none focus:!ring-0 placeholder:text-[var(--muted-foreground)]"
                    onContentSizeChange={setContentHeight}
                    disabled={disabled}
                    placeholder={streaming ? "补充这次创作的要求" : "描述你的想法，或用 @ 引用素材"}
                    aria-label="给助手的消息"
                />
            </div>

            {disabled && disabledReason ? <span className="canvas-assistant-meta">{disabledReason}</span> : null}

            <div className="canvas-assistant-composer-tools">
                {onFiles ? <Tooltip title="添加参考素材"><Button type="text" size="small" aria-label="添加参考素材" disabled={disabled || inputBusy} icon={<Paperclip size={15} />} onClick={() => fileInput.current?.click()} /></Tooltip> : null}
                {onOpenSkills ? <Tooltip title="选择技能"><Button type="text" size="small" aria-label="选择技能" disabled={disabled} icon={<Sparkles size={15} />} onClick={onOpenSkills} /></Tooltip> : null}
                {onOpenReferences ? <Button type="text" size="small" disabled={disabled} onClick={onOpenReferences}>画布素材</Button> : null}
            </div>
            <div className="canvas-assistant-composer-footer">
                <div className="canvas-assistant-composer-settings">
                <CanvasAssistantModelPicker busy={disabled || streaming || Boolean(modelBusy)} />
                {onPermissionChange ? <Tooltip title={permissionLocked ? "本轮权限已固定，结束后可更改" : "选择助手可访问和修改的范围"}>
                    <Select className="canvas-assistant-permission" size="small" variant="borderless" aria-label="助手权限" value={permissionMode} disabled={disabled || permissionLocked}
                        placement="topRight" popupMatchSelectWidth={false} onChange={onPermissionChange} options={[
                            { value: "read-only", label: "只读", title: "查看和分析，不修改内容" },
                            { value: "canvas", label: "当前画布", title: "查看素材并修改当前画布" },
                            { value: "full-access", label: "完全访问", title: "查看素材，可修改所有画布" },
                        ]} />
                </Tooltip> : null}
                </div>
                <div className="canvas-assistant-composer-actions">
                {streaming ? (
                    <>
                        <Button size="small" disabled={!canSend} loading={supplementBusy} onClick={onSend}>补充</Button>
                        <Button size="small" icon={<Square className="size-3" />} onClick={onStop}>停止</Button>
                    </>
                ) : (
                    <Tooltip title="Enter 发送 · Shift + Enter 换行" placement="topRight">
                        <Button className="canvas-assistant-send" shape="circle" type="primary" aria-label="发送" disabled={!canSend} icon={<ArrowUp className="size-4" />} onClick={onSend} />
                    </Tooltip>
                )}
                </div>
            </div>
        </footer>
    );
}
