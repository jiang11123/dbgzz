import type { StoryboardColumn, StoryboardRow } from "@/types/canvas";

export const STORYBOARD_CONTENT_COLUMNS = [
    { label: "视频提示词", value: "videoMotionPrompt" },
    { label: "图片提示词", value: "imageGenerationPrompt" },
    { label: "画面描述", value: "plotDescription" },
] as const;
export type StoryboardContentColumn = (typeof STORYBOARD_CONTENT_COLUMNS)[number]["value"];
const defaults: StoryboardColumn[] = ["shotNumber", "durationSeconds", "videoMotionPrompt", "dialogue", "assets"];
const previousDefaults: StoryboardColumn[][] = [defaults,
    ["shotNumber", "durationSeconds", "plotDescription", "dialogue"],
    ["shotNumber", "plotDescription", "videoMotionPrompt", "dialogue"]];

export function storyboardContentColumn(rows: StoryboardRow[]): StoryboardContentColumn {
    return STORYBOARD_CONTENT_COLUMNS.find(column => rows.some(row => row[column.value]?.trim()))?.value ?? "videoMotionPrompt";
}

export function resolveStoryboardVisibleColumns(columns: StoryboardColumn[] | undefined, rows: StoryboardRow[], customized = false): StoryboardColumn[] {
    if (customized && columns?.length) return columns;
    const defaultSelection = !columns?.length || previousDefaults.some(set => set.length === columns.length && set.every(column => columns.includes(column)));
    if (!defaultSelection) return columns!;
    const content = STORYBOARD_CONTENT_COLUMNS.filter(column => rows.some(row => row[column.value]?.trim())).map(column => column.value);
    return [...new Set<StoryboardColumn>([...defaults, ...content])];
}
