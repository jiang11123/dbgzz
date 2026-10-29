import { createDirectorObject } from "@/lib/canvas/director/director-scene";
import type { DirectorObject, DirectorPrimitiveKind } from "@/types/director";

export type DirectorGeometryPresetId = Exclude<DirectorPrimitiveKind, "plane" | "character">;

export const DIRECTOR_GEOMETRY_PRESET_OPTIONS: ReadonlyArray<{ id: DirectorGeometryPresetId; label: string; primitive: DirectorPrimitiveKind }> = [
    { id: "box", label: "立方体", primitive: "box" },
    { id: "sphere", label: "球体", primitive: "sphere" },
    { id: "cylinder", label: "圆柱体", primitive: "cylinder" },
    { id: "torus", label: "环状体", primitive: "torus" },
    { id: "cone", label: "圆锥", primitive: "cone" },
    { id: "pyramid", label: "棱锥", primitive: "pyramid" },
    { id: "empty", label: "添加空对象", primitive: "empty" },
];

export function createDirectorGeometricObject(preset: DirectorGeometryPresetId): DirectorObject {
    const option = DIRECTOR_GEOMETRY_PRESET_OPTIONS.find((item) => item.id === preset)!;
    return createDirectorObject(option.primitive, option.label);
}
