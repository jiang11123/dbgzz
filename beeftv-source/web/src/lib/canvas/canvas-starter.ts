export type CanvasStarterMode = "guided" | "freeform";

export type CanvasEmptyStateKind = "none" | "guided" | "freeform" | "linked";

export function resolveCanvasEmptyStateKind({
    nodeCount,
    shortDramaEnabled,
    isProjectLinked,
    starterMode,
}: {
    nodeCount: number;
    shortDramaEnabled: boolean;
    isProjectLinked: boolean;
    starterMode?: CanvasStarterMode;
}): CanvasEmptyStateKind {
    if (nodeCount > 0) return "none";
    if (!shortDramaEnabled) return "freeform";
    if (isProjectLinked) return "linked";
    // LibTV 的画布默认直接进入自由节点状态；短剧引导保留为显式选择后的入口，
    // 避免新画布第一次打开就被流程卡片覆盖，且与已有画布的空状态保持一致。
    return starterMode === "guided" ? "guided" : "freeform";
}
