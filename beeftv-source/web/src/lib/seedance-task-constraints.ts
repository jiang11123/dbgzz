import { isSeedance25Model } from "./model-capabilities";

export type SeedanceSettingsConstraints = { ratioLabel?: string; durationLocked?: boolean };
export function seedanceSettingsConstraints(model: string, imageCount: number, videoCount: number, audioCount: number, operation?: string, explicitFrame = false): SeedanceSettingsConstraints {
    if (!isSeedance25Model(model)) return {};
    const firstFrame = operation !== "reference_to_video" && (explicitFrame || (imageCount > 0 && imageCount <= 2 && !videoCount && !audioCount));
    const edit = videoCount > 0 && ["inpaint", "replace_element", "style_transfer"].includes(operation || "");
    const extend = videoCount > 0 && operation === "extend";
    return { ratioLabel: firstFrame ? "随首帧" : edit || extend ? "随原视频" : undefined, durationLocked: edit };
}

// Task intent comes from roles and the selected operation, never prompt keywords.
export function seedanceTaskOptions(model: string, ratio: string, duration: number, roles: string[], videoCount: number, operation?: string) {
    if (!isSeedance25Model(model)) return { ratio, duration };
    const edit = videoCount > 0 && ["inpaint", "replace_element", "style_transfer"].includes(operation || "");
    const locked = roles.some((role) => role === "first_frame" || role === "last_frame") || edit || (videoCount > 0 && operation === "extend");
    return { ratio: locked ? "adaptive" : ratio, duration: edit ? -1 : duration };
}

export function seedanceOmniTaskType(model: string, operation?: string, videoCount = 0): string | undefined {
    if (!isSeedance25Model(model)) return undefined;
    if (operation === "reference_to_video") return "reference";
    if (videoCount > 0 && operation === "extend") return "extend";
    if (videoCount > 0 && ["inpaint", "replace_element", "style_transfer"].includes(operation || "")) return "edit";
    return undefined;
}
