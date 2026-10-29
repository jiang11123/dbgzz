export type GeneratedShortDramaChapter = {
    title: string;
    content: string;
};

export type GeneratedShortDramaOutline = {
    title: string;
    synopsis: string;
    chapters: GeneratedShortDramaChapter[];
};

export function parseGeneratedStory(answer: string): GeneratedShortDramaOutline {
    const cleaned = answer
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    const payload = match ? JSON.parse(match[0]) as Record<string, unknown> : {};
    const title = String(payload.title || "").trim();
    const synopsis = String(payload.synopsis || "").trim();
    const chapters = Array.isArray(payload.chapters)
        ? payload.chapters
            .map((chapter: unknown) => {
                const item = typeof chapter === "object" && chapter ? chapter as Record<string, unknown> : {};
                return { title: String(item.title || "").trim(), content: String(item.content || "").trim() };
            })
            .filter((chapter: GeneratedShortDramaChapter) => chapter.title && chapter.content)
        : [];
    return { title: title || storyTitleFromAnswer(answer), synopsis, chapters };
}

export function storyTitleFromAnswer(answer: string) {
    const line = answer.split(/\r?\n/).find((item) => item.trim());
    return line ? line.trim().slice(0, 24) : "AI 生成短剧";
}

export function shortDramaOutlineVariables(input: {
    story: string;
    chapterCount: string;
    structure: string;
    wordCount: string;
    perspective: string;
    tone: string;
    characterScale: string;
    chapterLength: string;
}) {
    return {
        用户故事: input.story,
        章节数量: input.chapterCount,
        叙事结构: input.structure,
        每章字数: input.wordCount,
        叙事视角: input.perspective,
        整体基调: input.tone,
        角色规模: input.characterScale,
        章节篇幅: input.chapterLength,
    };
}
