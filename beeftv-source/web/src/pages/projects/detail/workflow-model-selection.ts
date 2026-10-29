import { seedancePortraitModel } from "@/lib/seedance-portrait";
import { configuredModelMatchesCapability, selectableModelsByCapability, type AiConfig, type ModelCapability } from "@/stores/use-config-store";

export function initialWorkbenchModel(config: AiConfig, projectModel: string | undefined, capability: ModelCapability): string {
    const globalModel = capability === "video" ? config.videoModel : config.imageModel;
    if (projectModel && (seedancePortraitModel(projectModel) || configuredModelMatchesCapability(config, projectModel, capability))) return projectModel;
    if (globalModel && (!projectModel || !seedancePortraitModel(globalModel))) return globalModel;
    return selectableModelsByCapability(config, capability).find((model) => !seedancePortraitModel(model)) || "";
}

// Catalog/default refreshes must not replace a choice the user already made.
export function refreshedWorkbenchModel(current: string, initial: string, sameScope: boolean): string {
    return sameScope && current ? current : initial;
}
