export type InputConstraint = { min: number; max: number };
export type OptionConstraint = { values?: unknown[]; min?: number; max?: number; step?: number };
export type CapabilityImageSizePreset = {
    size: string;
    tier: "1k" | "2k" | "4k";
    ratio: string;
    width: number;
    height: number;
};
export type CapabilityImageSize = {
    parameter?: "size" | "aspect_ratio";
    allowCustom?: boolean;
    presets?: CapabilityImageSizePreset[];
};
export type CapabilitySpec = {
    version: 1;
    capability: "text" | "image" | "video" | "audio";
    operations?: string[];
    inputs?: Record<string, InputConstraint>;
    options?: Record<string, OptionConstraint>;
    imageSize?: CapabilityImageSize;
};
