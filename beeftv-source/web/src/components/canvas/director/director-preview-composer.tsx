import { Input } from "antd";
import { ArrowUp, ImagePlus } from "lucide-react";

/**
 * 导演画布上的文本意图输入。
 * 只编辑已有 shot.prompt；不展示尚未接入的自然语言场景生成操作。
 */
export function DirectorPreviewComposer({ prompt, onPromptChange, intent = "shot", onAddReference, onSubmit, submitting = false, submitUnavailable = false }: { prompt: string; onPromptChange: (prompt: string) => void; intent?: "shot" | "scene"; onAddReference?: () => void; onSubmit?: () => void; submitting?: boolean; submitUnavailable?: boolean }) {
    const sceneIntent = intent === "scene";
    return (
        <div className={`director-preview-composer${sceneIntent ? " director-scene-composer" : ""}`} role="group" aria-label={sceneIntent ? "场景描述" : "镜头意图"}>
            <Input.TextArea aria-label={sceneIntent ? "场景描述" : "当前镜头意图"} data-canvas-no-zoom autoSize={{ minRows: 1, maxRows: 3 }} value={prompt} placeholder={sceneIntent ? "描述想搭建的场景" : "选中一个元素或机位，描述当前镜头的动作与叙事意图…"} onChange={(event) => onPromptChange(event.target.value)} onKeyDown={(event) => { if (sceneIntent && event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); if (!submitUnavailable) onSubmit?.(); } }} />
            {sceneIntent ? <div className="director-scene-composer-actions">
                <button type="button" data-canvas-no-zoom aria-label="添加场景参考图片" title="上传图片并作为场景参考立牌添加" disabled={submitting} onMouseDown={(event) => event.preventDefault()} onClick={onAddReference}><ImagePlus aria-hidden /></button>
                <button type="button" data-canvas-no-zoom data-unavailable={submitUnavailable || undefined} aria-label="将当前场景发送到画布" title={submitUnavailable ? "AI 自动构建暂未开放" : "将当前 3D 构图和描述应用到画布"} disabled={submitting || submitUnavailable} onMouseDown={(event) => event.preventDefault()} onClick={onSubmit}>{submitting ? <span className="director-composer-submit-spinner" aria-hidden /> : <ArrowUp aria-hidden />}</button>
            </div> : null}
        </div>
    );
}
