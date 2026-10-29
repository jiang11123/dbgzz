export const capabilityOptions = [{ value: "beeftv.canvas", label: "BeefTV 画布工具" }, { value: "model.image", label: "图片理解模型" }, { value: "model.video", label: "视频理解模型" }, { value: "model.audio", label: "音频理解模型" }];
export function requirementLabel(value: string) {
    return capabilityOptions.find(item => item.value === value)?.label || `未确认的能力：${value}`;
}
export function unsupportedRequirements(values: string[]) {
    return values.filter(value => !capabilityOptions.some(option => option.value === value));
}
export function publicationStatus(status: string) {
    return ({ awaiting_upload_confirmation: "等待确认上传", uploading: "上传结果待核对", needs_preview: "需要刷新预览", awaiting_submit_confirmation: "等待确认送审", submitted: "等待审核", in_review: "审核中", published: "已发布", rejected: "需要修改", withdrawn: "已撤回" } as Record<string, string>)[status] || "状态待刷新";
}
export function canSubmitPublication(plan: { status: string; preview?: unknown }, confirmed: boolean) {
    return confirmed && plan.status === "awaiting_submit_confirmation" && Boolean(plan.preview);
}
import type { PublishPlan } from "@/services/api/skill-market";

export function needsPublicationTargetCorrection(plan: Pick<PublishPlan, "submissionId" | "publicationTarget" | "marketSkillId" | "skillId" | "metadata">) {
    if (plan.submissionId) return false;
    if (plan.publicationTarget === "existing") return !plan.marketSkillId || plan.marketSkillId === plan.skillId || plan.metadata.skillId !== plan.marketSkillId;
    return Boolean(plan.metadata.skillId || plan.marketSkillId);
}
