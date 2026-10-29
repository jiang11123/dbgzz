import { http } from "@/services/api/request";
import { invalidateAddedSkillsCache, type Skill, type SkillPackageFile } from "./skills";

export type SkillMetadata = { skillId?: string; name: string; description: string; versionLabel: string; license: string; sourceUrl: string; requirements: string[]; requirementNotes?: string; minClientVersion?: string; showcase: Array<{ url: string; type: string; caption: string }> };
export type SkillReviewSummary = { reviewedAt: string; revision: number; contentHash: string; archiveSha256: string; previewDigest: string; trials: Array<{ scenario: string; target: string; runtimeVersion: string; model: string; conclusion: string; testedAt: string }> };
export type MarketRelease = SkillMetadata & { skillId: string; releaseId: string; author: string; archiveBytes: number; contentHash: string; archiveSha256: string; files: SkillPackageFile[]; publishedAt: string; review?: SkillReviewSummary };
export type MarketItem = SkillMetadata & { skillId: string; releaseId: string; author: string; compatibility: { status: string; reasons: string[] }; verification: string };
export type PublishPreview = { revision: number; previewDigest: string; author: string; metadata: SkillMetadata; files: SkillPackageFile[]; warnings: string[] };
export type PublicationTarget = { publicationTarget: "new" | "existing"; marketSkillId?: string };
export type PublishPlan = { planId: string; skillId: string; versionId: string; canvasId?: string; publicationTarget?: PublicationTarget["publicationTarget"]; marketSkillId?: string; archiveSha256: string; instruction: string; metadata: SkillMetadata; files: SkillPackageFile[]; status: string; submissionId?: string; revision?: number; preview?: PublishPreview; reviewReason?: string; createdAt: string };
export type MarketAuthorization = { connected?: boolean; pending?: boolean; userCode?: string; verificationUrl?: string; websiteUrl?: string; interval?: number; expiresIn?: number };
export type InstalledVersion = { id: string; versionLabel: string; contentHash: string; createdAt: string };
const root = "/skills/market";
const id = encodeURIComponent;
const changed = <T>(promise: Promise<T>) => promise.finally(invalidateAddedSkillsCache);

export const searchSkillMarket = (q: string, page = 1) => http.get<{ items: MarketItem[]; total: number }>(`${root}/search`, { params: { q, page, pageSize: 20 } });
export const getMarketRelease = (skillId: string, releaseId: string) => http.get<MarketRelease>(`${root}/releases/${id(skillId)}/${id(releaseId)}`);
export const getMarketFile = (skillId: string, releaseId: string, path: string, offset = 0) => http.get<{ content: string; encoding: string; eof: boolean; nextOffset: number }>(`${root}/releases/${id(skillId)}/${id(releaseId)}/file`, { params: { path, offset } });
export const installMarketRelease = (skillId: string, releaseId: string) => changed(http.post<{ skill: Skill }>(`${root}/install`, { skillId, releaseId }));
export const getInstalledVersions = (skillId: string) => http.get<{ versions: InstalledVersion[] }>(`${root}/versions/${id(skillId)}`);
export const rollbackSkill = (skillId: string, versionId: string) => changed(http.post<{ skill: Skill }>(`${root}/rollback`, { skillId, versionId }));
export const forkSkill = (skillId: string) => changed(http.post<{ skill: Skill }>(`${root}/fork`, { skillId }));
export const getMarketAuthorization = () => http.get<MarketAuthorization>(`${root}/authorization`);
export const startMarketAuthorization = () => http.post<MarketAuthorization>(`${root}/authorization/start`);
export const disconnectMarketAuthorization = () => http.delete<MarketAuthorization>(`${root}/authorization`);
export const listPublishPlans = () => http.get<{ items: PublishPlan[] }>(`${root}/publish-plans`);
export const preparePublication = (skillId: string, metadata: SkillMetadata, target: PublicationTarget, sourcePlanId?: string) => http.post<PublishPlan>(`${root}/publish-plans`, { skillId, metadata, ...target, sourcePlanId });
export const refreshPublication = (planId: string) => http.post<PublishPlan>(`${root}/publish-plans/${id(planId)}/refresh`);
// These two calls are used only by user confirmation controls, never by the model tool surface.
export const uploadPublication = (plan: PublishPlan) => http.post<PublishPlan>(`${root}/publish-plans/${id(plan.planId)}/upload`, { confirmed: true, archiveSha256: plan.archiveSha256 });
export const submitPublication = (plan: PublishPlan) => {
    if (!plan.preview || plan.status !== "awaiting_submit_confirmation") return Promise.reject(new Error("请先刷新并检查公开预览"));
    return http.post<PublishPlan>(`${root}/publish-plans/${id(plan.planId)}/submit`, { confirmed: true, revision: plan.preview.revision, previewDigest: plan.preview.previewDigest });
};
