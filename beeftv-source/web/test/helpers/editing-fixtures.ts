import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { CanonicalSourceMeta, CanonicalTimelinePlan } from "../../src/lib/timeline/timeline-canonical-plan";
import type { TimelineProject } from "../../src/types/timeline";

const root = resolve(import.meta.dir, "../../../fixtures/editing");

export function loadEditingPlan(name: string): CanonicalTimelinePlan {
    return JSON.parse(readFileSync(resolve(root, name), "utf8")) as CanonicalTimelinePlan;
}

export function loadEditingTimeline(name: string): {
    timeline: TimelineProject;
    sources: CanonicalSourceMeta[];
    options: { width?: number; height?: number; fps?: number; sampleRate?: number; burnSubtitles?: boolean };
} {
    return JSON.parse(readFileSync(resolve(root, name), "utf8"));
}
