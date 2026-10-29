/** Versioned semantic timeline plan compiled by Go internal/editing. */

export const CANONICAL_PLAN_VERSION = 1;

export type CanonicalPlanOutput = {
    width: number;
    height: number;
    fps: number;
    sampleRate: number;
    burnSubtitles: boolean;
};

export type CanonicalSegment = {
    kind: "video" | "image" | "gap";
    clipId?: string;
    sourceId?: string;
    startMs: number;
    durationMs: number;
    sourceStartMs?: number;
    volume: number;
    fadeInMs?: number;
    fadeOutMs?: number;
    muted?: boolean;
    hasAudio: boolean;
};

export type CanonicalAudioClip = {
    clipId: string;
    sourceId: string;
    startMs: number;
    durationMs: number;
    sourceStartMs: number;
    volume: number;
    fadeInMs?: number;
    fadeOutMs?: number;
    muted?: boolean;
};

export type CanonicalSubtitle = {
    clipId: string;
    startMs: number;
    durationMs: number;
    text: string;
};

export type CanonicalTimelinePlan = {
    version: number;
    output: CanonicalPlanOutput;
    durationMs: number;
    segments: CanonicalSegment[];
    audio: CanonicalAudioClip[];
    subtitles: CanonicalSubtitle[];
    subtitleSrt?: string;
};

export type CanonicalSourceMeta = {
    id: string;
    kind?: string;
    hasAudio?: boolean | null;
    hasVideo?: boolean | null;
    durationMs?: number;
};

export type CanonicalPlanOptions = {
    width?: number;
    height?: number;
    fps?: number;
    sampleRate?: number;
    burnSubtitles?: boolean;
};

export const DURATION_TOLERANCE_MS = 100;

export type CanonicalSourceFacts = {
    hasAudio: boolean;
    hasVideo: boolean;
    durationMs: number;
};

export function assertCanonicalPlan(plan: CanonicalTimelinePlan): void {
    if (!plan || plan.version !== CANONICAL_PLAN_VERSION) {
        throw new Error("不支持的渲染计划版本");
    }
    const hasVisual = plan.segments?.some((segment) => segment.kind !== "gap");
    if (!hasVisual && !(plan.audio?.length)) {
        throw new Error("时间线没有可渲染的媒体片段");
    }
}

/** Bind probe results onto an already compiled plan. Does not re-select content. */
export function applySourceFacts(plan: CanonicalTimelinePlan, facts: Record<string, CanonicalSourceFacts>): void {
    for (const segment of plan.segments || []) {
        if (segment.kind === "gap") {
            segment.hasAudio = false;
            continue;
        }
        const fact = facts[segment.sourceId || ""];
        if (!fact) throw new Error("找不到素材：" + (segment.clipId || segment.sourceId || ""));
        if (segment.kind === "image") {
            segment.hasAudio = false;
            continue;
        }
        if (segment.kind === "video") {
            if (!fact.hasVideo) throw new Error("素材缺少所需音视频轨：" + (segment.clipId || ""));
            if (fact.durationMs <= 0) throw new Error("无法解析素材：" + (segment.clipId || ""));
            if ((segment.sourceStartMs || 0) + segment.durationMs > fact.durationMs + DURATION_TOLERANCE_MS) {
                throw new Error("素材时长不足，请调整裁剪范围：" + (segment.clipId || ""));
            }
            segment.hasAudio = fact.hasAudio && !segment.muted;
        }
    }
    for (const clip of plan.audio || []) {
        const fact = facts[clip.sourceId];
        if (!fact) throw new Error("找不到素材：" + clip.clipId);
        if (!fact.hasAudio) throw new Error("独立音频素材没有可用音轨");
        if (fact.durationMs <= 0) throw new Error("无法解析素材：" + clip.clipId);
        if (clip.sourceStartMs + clip.durationMs > fact.durationMs + DURATION_TOLERANCE_MS) {
            throw new Error("素材时长不足，请调整裁剪范围：" + clip.clipId);
        }
    }
}

export function canonicalSourceIds(plan: CanonicalTimelinePlan): string[] {
    const ids = new Set<string>();
    for (const segment of plan.segments) {
        if (segment.kind !== "gap" && segment.sourceId) ids.add(segment.sourceId);
    }
    for (const clip of plan.audio || []) {
        if (clip.sourceId) ids.add(clip.sourceId);
    }
    return [...ids];
}
