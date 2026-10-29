import { createDirectorObject, DIRECTOR_ACTOR_COLORS } from "@/lib/canvas/director/director-scene";
import { resolveDirectorBuiltInActorUrl } from "@/lib/canvas/director/director-actor-assets";
import type { DirectorActorPresetId, DirectorObject, DirectorVec3 } from "@/types/director";

export const DIRECTOR_ACTOR_PRESET_OPTIONS: ReadonlyArray<{ id: DirectorActorPresetId; label: string }> = [
    { id: "standard_male", label: "标准男性" },
    { id: "standard_female", label: "标准女性" },
    { id: "geometric", label: "几何模型" },
];

export const DIRECTOR_ACTOR_CROWD_LABEL = "群众 (3x3)";

export type DirectorActorShape = {
    scale: DirectorVec3;
    shoulders: number;
    waist: number;
    hips: number;
    head: number;
    limbs: number;
    armSpan: number;
    armLength: number;
    stance: number;
    legLength: number;
    torsoLength: number;
    footLength: number;
    radialSegments: number;
};

/** Lightweight stylized-human proportions. Every named preset changes actual anatomy, not just its display name. */
const ACTOR_SHAPES: Record<DirectorActorPresetId, DirectorActorShape> = {
    standard_male: { scale: [1, 1, 1], shoulders: 1, waist: 1, hips: 1, head: 1, limbs: 1, armSpan: 1, armLength: 1, stance: 1, legLength: 1, torsoLength: 1, footLength: 1, radialSegments: 20 },
    standard_female: { scale: [0.98, 1, 0.98], shoulders: 0.88, waist: 0.78, hips: 1.11, head: 0.98, limbs: 0.91, armSpan: 0.94, armLength: 0.98, stance: 0.96, legLength: 1.02, torsoLength: 0.96, footLength: 0.95, radialSegments: 20 },
    athletic: { scale: [1, 1, 1], shoulders: 1.2, waist: 0.98, hips: 1.04, head: 0.98, limbs: 1.15, armSpan: 1.1, armLength: 1.04, stance: 1.05, legLength: 1.04, torsoLength: 1.04, footLength: 1.02, radialSegments: 20 },
    slim: { scale: [0.97, 1, 0.96], shoulders: 0.88, waist: 0.76, hips: 0.88, head: 0.98, limbs: 0.79, armSpan: 0.95, armLength: 1.06, stance: 0.94, legLength: 1.07, torsoLength: 1.02, footLength: 0.95, radialSegments: 20 },
    teen: { scale: [0.93, 1, 0.94], shoulders: 0.92, waist: 0.89, hips: 0.93, head: 1.1, limbs: 0.86, armSpan: 0.93, armLength: 0.88, stance: 0.94, legLength: 0.86, torsoLength: 0.92, footLength: 0.91, radialSegments: 20 },
    child: { scale: [0.87, 1, 0.88], shoulders: 0.89, waist: 0.93, hips: 1.03, head: 1.3, limbs: 0.85, armSpan: 0.88, armLength: 0.74, stance: 0.91, legLength: 0.67, torsoLength: 0.8, footLength: 0.87, radialSegments: 20 },
    broad: { scale: [1.05, 1, 1.04], shoulders: 1.2, waist: 1.14, hips: 1.2, head: 1.03, limbs: 1.12, armSpan: 1.08, armLength: 0.98, stance: 1.08, legLength: 0.98, torsoLength: 1.03, footLength: 1.08, radialSegments: 20 },
    chibi: { scale: [1, 1, 1], shoulders: 1.1, waist: 1.05, hips: 1.13, head: 1.55, limbs: 1.03, armSpan: 0.86, armLength: 0.61, stance: 0.93, legLength: 0.48, torsoLength: 0.72, footLength: 1.06, radialSegments: 16 },
    geometric: { scale: [1, 1, 1], shoulders: 1, waist: 1, hips: 1, head: 1, limbs: 1, armSpan: 1, armLength: 1, stance: 1, legLength: 1, torsoLength: 1, footLength: 1, radialSegments: 8 },
};

export function resolveDirectorActorShape(preset: DirectorActorPresetId): DirectorActorShape {
    const shape = ACTOR_SHAPES[preset] || ACTOR_SHAPES.standard_male;
    return { ...shape, scale: [...shape.scale] as DirectorVec3 };
}

// Legacy labels remain available for scenes created before the simplified preset menu.
const LABEL_BY_PRESET: Record<DirectorActorPresetId, string> = {
    standard_male: "标准男性",
    standard_female: "标准女性",
    athletic: "健硕",
    slim: "纤细",
    teen: "少年",
    child: "儿童",
    broad: "宽厚",
    chibi: "二头身",
    geometric: "几何模型",
};

/** Keep rounded capsule limbs inside their skeleton endpoints, including short neck/forearm segments. */
export function resolveDirectorCapsuleShape(length: number, desiredRadius: number): { radius: number; cylinderHeight: number } {
    const radius = Math.min(Math.max(0, desiredRadius), Math.max(0, length) / 2);
    return { radius, cylinderHeight: Math.max(0, length - radius * 2) };
}

/** Human presets share the two bundled rigged bases; the viewport reshapes each anatomy. */
export function createDirectorActorPreset(preset: DirectorActorPresetId, name = LABEL_BY_PRESET[preset], position: DirectorVec3 = [0, 0, 0], color: string = DIRECTOR_ACTOR_COLORS[0]): DirectorObject {
    const url = resolveDirectorBuiltInActorUrl(preset);
    return {
        ...createDirectorObject("box", name, position, color),
        kind: "actor",
        primitive: undefined,
        pose: "stand",
        actorPreset: preset,
        url: url || undefined,
        mimeType: url ? "model/gltf-binary" : undefined,
        rig: { status: "unmapped", boneMap: {}, animationNames: [] },
        motionClips: [],
        boneOverrides: {},
        boneTracks: [],
    };
}

/** 3x3 crowd option is one logical creation action with nine distinct actor records. */
export function createDirectorActorCrowd(group = 1, rows = 3, columns = 3, spacing = 1.2): DirectorObject[] {
    const safeRows = Math.max(1, Math.min(10, Math.round(rows)));
    const safeColumns = Math.max(1, Math.min(10, Math.round(columns)));
    const safeSpacing = Math.max(0.5, Math.min(5, spacing));
    return Array.from({ length: safeRows * safeColumns }, (_, index) => {
        const row = Math.floor(index / safeColumns);
        const column = index % safeColumns;
        const position: DirectorVec3 = [(column - (safeColumns - 1) / 2) * safeSpacing, 0, (row - (safeRows - 1) / 2) * safeSpacing];
        return createDirectorActorPreset("standard_male", `群众 ${group}-${index + 1}`, position);
    });
}
