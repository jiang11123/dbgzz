export const PromptTemplateOperation = {
    ChapterAssetsExtract: "chapter_assets_extract",
    CharacterExtract: "character_extract",
    CharacterTurnaround: "character_turnaround",
    StoryboardPlan: "storyboard_plan",
    StoryboardRepair: "storyboard_repair",
    StoryboardFirstFrame: "storyboard_first_frame",
    StoryboardVideo: "storyboard_video",
    ShortDramaOutline: "short_drama_outline",
    SkillDraft: "skill_draft",
} as const;

export type PromptTemplateOperationId = (typeof PromptTemplateOperation)[keyof typeof PromptTemplateOperation];

export function promptTemplateTaskPlaceholder(label: string) {
    return `使用当前启用的${label}模板。`;
}
