import { useEffect, useState } from "react";

import { CanvasNodeUpscaleDialog, type CanvasImageUpscaleParams } from "@/components/canvas/canvas-node-upscale-dialog";
import type { CanvasNodeData } from "@/types/canvas";
import type { AiConfig } from "@/stores/use-config-store";
import { resolveImageUrl } from "@/services/image-storage";

type CanvasProjectMediaDialogsProps = {
    upscaleNode: CanvasNodeData | null;
    onCloseUpscale: () => void;
    onUpscale: (node: CanvasNodeData, params: CanvasImageUpscaleParams) => void;
    config: AiConfig;
};

export function CanvasProjectMediaDialogs({
    upscaleNode,
    onCloseUpscale,
    onUpscale,
    config,
}: CanvasProjectMediaDialogsProps) {
    const upscaleImageUrl = useResolvedCanvasImageUrl(upscaleNode);

    return (
        <>
            {upscaleNode && upscaleImageUrl ? <CanvasNodeUpscaleDialog dataUrl={upscaleImageUrl} open onClose={onCloseUpscale} onConfirm={(params) => onUpscale(upscaleNode, params)} /> : null}
        </>
    );
}

function useResolvedCanvasImageUrl(node: CanvasNodeData | null) {
    const storageKey = node?.metadata?.storageKey || "";
    const content = node?.metadata?.content || "";
    const [url, setUrl] = useState("");

    useEffect(() => {
        let active = true;
        setUrl("");
        if (!storageKey) {
            setUrl(content);
            return () => {
                active = false;
            };
        }

        void resolveImageUrl(storageKey, content, { cacheMiss: true }).then((resolved) => {
            if (active) setUrl(resolved || content);
        }).catch(() => {
            if (active) setUrl(content);
        });
        return () => {
            active = false;
        };
    }, [content, storageKey]);

    return url;
}
