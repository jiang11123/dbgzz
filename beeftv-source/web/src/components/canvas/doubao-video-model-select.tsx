import { Select } from "antd";

import { DOUBAO_VIDEO_MODEL_OPTIONS, normalizeDoubaoVideoModel } from "@/lib/doubao-video-model";

type Props = {
    value: string | undefined;
    onChange: (model: string) => void;
    disabled?: boolean;
};

/** 选了豆包账号视频模型后，在模型选择器旁边出现的「豆包视频模型」选择（Seedance 2.5 / 2.0 …）。 */
export function DoubaoVideoModelSelect({ value, onChange, disabled }: Props) {
    return (
        <Select
            className="canvas-doubao-video-model"
            size="small"
            aria-label="豆包视频模型"
            title="豆包视频模型"
            value={normalizeDoubaoVideoModel(value)}
            options={DOUBAO_VIDEO_MODEL_OPTIONS.map((model) => ({ value: model, label: model }))}
            onChange={onChange}
            disabled={disabled}
            placement="topLeft"
            popupMatchSelectWidth={false}
            style={{ minWidth: 128, flexShrink: 0 }}
        />
    );
}
