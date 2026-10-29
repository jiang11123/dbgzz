import { buildGenerationConfig } from "@/lib/canvas/canvas-project-generation";
import { PromptTemplateOperation, promptTemplateTaskPlaceholder } from "@/lib/prompts";
import { runBackendGenerationTask } from "@/services/api/generation-task";
import type { AiConfig } from "@/stores/use-config-store";

export type SkillDraft = {
    skillName: string;
    description: string;
    instruction: string;
    tag?: string;
};

const MAX_NAME_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 500;

export function parseSkillDraft(text: string): Partial<SkillDraft> {
    const trimmed = (text || "").trim();
    if (!trimmed) return {};
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
        try {
            const raw = JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
            if (raw && typeof raw === "object") {
                return {
                    skillName: String(raw.skillName ?? raw.skill_name ?? "").trim().slice(0, MAX_NAME_LENGTH),
                    description: String(raw.description ?? "").trim().slice(0, MAX_DESCRIPTION_LENGTH),
                    instruction: String(raw.instruction ?? raw.instructions ?? "").trim(),
                    tag: typeof raw.tag === "string" && raw.tag.trim() ? raw.tag.trim() : undefined,
                };
            }
        } catch {
            // JSON 解析失败时回退到文本整体方案
        }
    }
    // 回退：首行作为名称，正文作为简介与指令，用户随后可自由编辑
    const firstLine = trimmed.split(/\r?\n/)[0]?.trim().slice(0, 30) || "未命名技能";
    return {
        skillName: firstLine,
        description: trimmed.slice(0, MAX_DESCRIPTION_LENGTH),
        instruction: trimmed,
    };
}

export async function generateSkillDraft(idea: string, config: AiConfig, signal?: AbortSignal): Promise<Partial<SkillDraft>> {
    const generationConfig = buildGenerationConfig(config, undefined, "text");
    const result = await runBackendGenerationTask({
        mode: "text",
        prompt: promptTemplateTaskPlaceholder("技能草稿"),
        config: generationConfig,
        metadata: {
            source: "skill-draft",
            promptTemplateOperation: PromptTemplateOperation.SkillDraft,
            promptTemplateVariables: { 用户想法: idea.trim() },
        },
        signal,
    });
    return parseSkillDraft(result.text || "");
}