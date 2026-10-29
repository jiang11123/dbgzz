import { describe, expect, test } from "bun:test";

import { applySourceFacts, assertCanonicalPlan, canonicalSourceIds } from "../src/lib/timeline/timeline-canonical-plan";
import { loadEditingPlan } from "./helpers/editing-fixtures";

describe("canonical plan facts", () => {
    test("applySourceFacts 把无音轨视频改静音，不重排片段", () => {
        const plan = structuredClone(loadEditingPlan("gap-silent-fade.plan.json"));
        const sourceIds = canonicalSourceIds(plan);
        expect(sourceIds).toEqual(["tone", "silent", "voice"]);
        applySourceFacts(plan, {
            tone: { hasVideo: true, hasAudio: true, durationMs: 1000 },
            silent: { hasVideo: true, hasAudio: false, durationMs: 1000 },
            voice: { hasAudio: true, hasVideo: false, durationMs: 2000 },
        });
        expect(plan.segments[0].hasAudio).toBe(true);
        expect(plan.segments[2].hasAudio).toBe(false);
        expect(plan.segments.map((segment) => segment.kind)).toEqual(["video", "gap", "video"]);
    });

    test("素材时长不足必须失败且不丢弃计划片段", () => {
        const plan = structuredClone(loadEditingPlan("gap-silent-fade.plan.json"));
        expect(() => applySourceFacts(plan, {
            tone: { hasVideo: true, hasAudio: true, durationMs: 100 },
            silent: { hasVideo: true, hasAudio: false, durationMs: 1000 },
            voice: { hasAudio: true, hasVideo: false, durationMs: 2000 },
        })).toThrow("素材时长不足");
        expect(plan.segments).toHaveLength(3);
        expect(plan.audio).toHaveLength(1);
    });

    test("不支持的计划版本必须失败", () => {
        const plan = structuredClone(loadEditingPlan("gap-mix.plan.json"));
        plan.version = 2;
        expect(() => assertCanonicalPlan(plan)).toThrow("不支持的渲染计划版本");
    });
});
