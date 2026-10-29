import { useState } from "react";
import { Camera } from "lucide-react";

import { AppModal } from "@/components/ui/product/app-modal/app-modal";
import type { CanvasTheme } from "@/lib/canvas-theme";
import type { CameraControlOptions } from "@/lib/canvas/camera-prompt-library";
import { CanvasNodeCameraPanel } from "./canvas-node-camera-dialog";

type CanvasCameraControlPopoverProps = {
    cameraControl?: CameraControlOptions;
    onCameraControlChange: (options: CameraControlOptions) => void;
    theme: CanvasTheme;
    compact?: boolean;
    label?: string;
};

export function CanvasCameraControlPopover({ cameraControl, onCameraControlChange, theme, compact = false, label = "摄像机" }: CanvasCameraControlPopoverProps) {
    const [open, setOpen] = useState(false);
    const cameraEnabled = cameraControl?.enabled === true;
    return (
        <>
            <button
                type="button"
                className={`canvas-node-composer-camera-tools-trigger inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 text-[var(--fs-tiny)] transition-colors ${compact ? "is-compact h-7" : "h-8"}`}
                style={{
                    background: cameraEnabled ? `${theme.node.activeStroke}66` : theme.node.fill,
                    color: cameraEnabled ? theme.node.panel : theme.node.text,
                }}
                aria-pressed={cameraEnabled}
                aria-label={label}
                title={`${label}${cameraEnabled ? " · 已启用" : ""}`}
                onClick={() => setOpen(true)}
            >
                <Camera className="size-3.5" />
                {!compact ? <span>{label}</span> : null}
            </button>
            {open ? (
                <AppModal title={null} closable={false} open centered footer={null} width={780} flush onCancel={() => setOpen(false)}>
                    <CanvasNodeCameraPanel
                        cameraControl={cameraControl}
                        onClose={() => setOpen(false)}
                        onConfirm={(options) => {
                            onCameraControlChange(options);
                            setOpen(false);
                        }}
                    />
                </AppModal>
            ) : null}
        </>
    );
}
