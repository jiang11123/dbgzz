import type { GenerationErrorCategory } from "./generation-error";

type ModerationCopy = { category: GenerationErrorCategory; reason: string; action: string };
const labels: Record<string, string[]> = {
    input: ["输入文本", "参考图片", "参考视频", "参考音频"],
    output: ["生成文字", "生成图片", "生成视频", "生成音频"],
};
const mediaTypes = ["text", "image", "video", "audio"];

// Ark's documented families encode direction, medium and cause separately.
// PolicyViolation means copyright here; it is not a generic real-person rule.
export function moderationErrorCopy(code: string, message: string): ModerationCopy | undefined {
    const match = code.toLowerCase().match(/^(input|output)(text|image|video|audio)(?:sensitivecontentdetected|riskdetection)(?:\.(policyviolation|privacyinformation|deepfake))?$/);
    let direction = match?.[1];
    let media = match?.[2];
    let cause = match?.[3] || "";
    if (!direction) {
        if (/prompt\s+or\s+(?:reference|input)\s+/i.test(message)) return;
        if (/\boutput may contain sensitive information\b/i.test(message)) return { category: "moderation_output", reason: "生成结果未通过内容安全审核", action: "请调整提示词或参考素材后重新生成" };
        const subject = message.toLowerCase().match(/\b(input|output|reference)\s+(text|image|video|audio)\b/);
        const safety = /may contain sensitive information|includes sensitive content|content (?:safety|policy)|safety policy|copyright restrictions|may contain real person|counterfeit documents or credentials/i.test(message);
        if (!subject || !safety) return;
        direction = subject[1] === "reference" ? "input" : subject[1];
        media = subject[2];
        if (/copyright restrictions/i.test(message)) cause = "policyviolation";
        else if (/may contain real person/i.test(message)) cause = "privacyinformation";
        else if (/counterfeit documents or credentials/i.test(message)) cause = "deepfake";
    }
    const label = labels[direction][mediaTypes.indexOf(media!)];
    const category: GenerationErrorCategory = direction === "output" ? "moderation_output" : media === "text" ? "moderation_input" : "moderation_reference";
    let reason = `${label}未通过内容安全审核`;
    let action = direction === "output" ? "请调整提示词；如使用了参考素材，请检查并更换后重新生成" : media === "text" ? "请调整提示词后重新生成" : `请检查并更换${label}后重新生成`;
    if (cause === "policyviolation") {
        reason = `${label}未通过上游版权审核`;
        if (direction === "output" && media === "audio") action = "请调整音乐或音频相关提示词；如使用了参考音频，请检查并更换后重新生成";
    } else if (cause === "privacyinformation") {
        reason = direction === "input" && (media === "image" || media === "video") ? `${label}疑似包含真人形象，该模型拒绝生成` : `${label}未通过隐私审核`;
    } else if (cause === "deepfake") {
        reason = `${label}未通过伪造内容审核`;
    }
    return { category, reason, action };
}

// Persist only our exact generated copy, never arbitrary provider instructions.
export function persistedModerationCopy(text: string): ModerationCopy | undefined {
    for (const direction of ["input", "output"]) {
        for (const media of mediaTypes) {
            for (const suffix of ["", ".PolicyViolation", ".PrivacyInformation", ".DeepFake"]) {
                const copy = moderationErrorCopy(`${direction}${media}SensitiveContentDetected${suffix}`, "")!;
                if (text.startsWith(`${copy.reason}。${copy.action}。`)) return copy;
            }
        }
    }
}
