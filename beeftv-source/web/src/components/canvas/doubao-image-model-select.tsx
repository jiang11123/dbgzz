import { Select } from "antd";

import { DOUBAO_IMAGE_MODEL_OPTIONS, normalizeDoubaoImageModel } from "@/lib/doubao-image-model";

type Props = {
    value: string | undefined;
    onChange: (model: string) => void;
    disabled?: boolean;
};

/** 选了豆包账号图片模型后，在模型选择器旁边出现的「豆包图片模型」选择（Seedream 4.5 / 4.0 / 3.0）。 */
export function DoubaoImageModelSelect({ value, onChange, disabled }: Props) {
    return (
        <Select
            className="canvas-doubao-image-model"
            size="small"
            aria-label="豆包图片模型"
            title="豆包图片模型"
            value={normalizeDoubaoImageModel(value)}
            options={DOUBAO_IMAGE_MODEL_OPTIONS.map((model) => ({ value: model, label: model }))}
            onChange={onChange}
            disabled={disabled}
            placement="topLeft"
            popupMatchSelectWidth={false}
            style={{ minWidth: 120, flexShrink: 0 }}
        />
    );
}
