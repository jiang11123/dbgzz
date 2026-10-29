import { ArrowDown, ArrowUp } from "lucide-react";
import { useEffect } from "react";
import type { NodeGenerationInput } from "./canvas-node-generation";
import type { CanvasNodeMetadata } from "@/types/canvas";

export function CanvasH3ReferenceOrder({ model, inputs, metadata, onChange }: { model: string; inputs: Array<Pick<NodeGenerationInput, "nodeId" | "type" | "title">>; metadata?: CanvasNodeMetadata; onChange: (patch: Partial<CanvasNodeMetadata>) => void }) {
    const supported = ["minimax-h3-max", "minimax-h3-max-turbo"].includes(model.split("::").at(-1) || "");
    const frames = [metadata?.videoStartFrameNodeId, metadata?.videoEndFrameNodeId, metadata?.videoMiddleFrameNodeId];
    const rank = { image: 0, character: 0, video: 1, audio: 2, text: 3 };
    const refs = inputs.filter((i) => ["image", "character", "video", "audio"].includes(i.type) && !frames.includes(i.nodeId)).sort((a, b) => rank[a.type] - rank[b.type]);
    const saved = metadata?.videoReferenceOrder || [];
    const order = [...saved.filter((id) => refs.some((i) => i.nodeId === id)), ...refs.map((i) => i.nodeId).filter((id) => !saved.includes(id))];
    const orderKey = JSON.stringify(order),
        savedKey = JSON.stringify(saved);
    useEffect(() => {
        if (supported && metadata?.videoReferenceOrder && orderKey !== savedKey) onChange({ videoReferenceOrder: JSON.parse(orderKey) });
    }, [supported, orderKey, savedKey, metadata?.videoReferenceOrder, onChange]);
    if (!supported || !order.length) return null;
    const move = (index: number, offset: number) => {
        const next = [...order];
        [next[index], next[index + offset]] = [next[index + offset]!, next[index]!];
        onChange({ videoReferenceOrder: next, videoEditOperation: "reference_to_video" });
    };
    return (
        <details className="mt-2 rounded border border-[var(--color-border)] px-2 py-2" data-canvas-no-zoom>
            <summary className="cursor-pointer text-[var(--fs-tiny)]">参考素材顺序</summary>
            <p className="my-2 text-[var(--fs-micro)] opacity-65">调整参考顺序，同时切换为参考生成。角色卡的图片和声音按卡片位置传入；未排序的引用放在末尾。</p>
            <ol className="flex flex-col gap-1">
                {order.map((id, index) => {
                    const item = refs.find((i) => i.nodeId === id)!;
                    return (
                        <li key={id} className="flex min-w-0 items-center gap-1">
                            <span className="shrink-0 text-[var(--fs-micro)]">{index + 1}.</span>
                            <span className="min-w-0 flex-1 truncate text-[var(--fs-micro)]">{item.title}</span>
                            <button type="button" aria-label={`上移 ${item.title}`} disabled={index === 0} onClick={() => move(index, -1)} className="rounded p-1 disabled:opacity-30">
                                <ArrowUp size={14} />
                            </button>
                            <button type="button" aria-label={`下移 ${item.title}`} disabled={index === order.length - 1} onClick={() => move(index, 1)} className="rounded p-1 disabled:opacity-30">
                                <ArrowDown size={14} />
                            </button>
                        </li>
                    );
                })}
            </ol>
        </details>
    );
}
