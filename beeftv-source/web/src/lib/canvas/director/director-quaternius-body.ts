import { Bone, Matrix4, SkinnedMesh, Vector3, type Object3D } from "three";
import type { DirectorActorPresetId } from "@/types/director";

type BodyProfile = {
    leg: number;
    torso: number;
    headHeight: number;
    shoulders: number;
    waist: number;
    hips: number;
    arms: number;
    headWidth: number;
    chestDepth: number;
    bellyDepth: number;
};

// Measured against the saved LibTV preset screenshots at the same camera angle.
// The Quaternius body is 1.81 units tall in its rest pose, with hips at .95 and neck at 1.56.
const BODY_PROFILES: Partial<Record<DirectorActorPresetId, BodyProfile>> = {
    athletic: { leg: 1.08, torso: 1.11, headHeight: 1.03, shoulders: 1.18, waist: 1.04, hips: 1.08, arms: 1.09, headWidth: 1.01, chestDepth: 1.16, bellyDepth: 1.03 },
    slim: { leg: 0.95, torso: 0.94, headHeight: 0.97, shoulders: 0.84, waist: 0.76, hips: 0.84, arms: 0.9, headWidth: 0.96, chestDepth: 0.83, bellyDepth: 0.78 },
    teen: { leg: 0.8, torso: 0.84, headHeight: 0.96, shoulders: 0.86, waist: 0.84, hips: 0.88, arms: 0.83, headWidth: 1.08, chestDepth: 0.88, bellyDepth: 0.86 },
    child: { leg: 0.55, torso: 0.62, headHeight: 1.0, shoulders: 0.77, waist: 0.83, hips: 0.86, arms: 0.66, headWidth: 1.27, chestDepth: 0.82, bellyDepth: 0.88 },
    broad: { leg: 0.96, torso: 1.0, headHeight: 0.96, shoulders: 1.16, waist: 1.2, hips: 1.19, arms: 1.06, headWidth: 1.04, chestDepth: 1.16, bellyDepth: 1.29 },
    chibi: { leg: 0.25, torso: 0.43, headHeight: 1.2, shoulders: 0.76, waist: 0.92, hips: 1.0, arms: 0.6, headWidth: 1.58, chestDepth: 0.92, bellyDepth: 1.0 },
};

const HIP_Y = 0.95;
const NECK_Y = 1.56;

function blend(a: number, b: number, t: number): number {
    return a + (b - a) * Math.min(1, Math.max(0, t));
}

function widthAt(y: number, profile: BodyProfile): number {
    if (y < HIP_Y) return profile.hips;
    if (y < 1.13) return blend(profile.hips, profile.waist, (y - HIP_Y) / 0.18);
    if (y < 1.43) return blend(profile.waist, profile.shoulders, (y - 1.13) / 0.3);
    return blend(profile.shoulders, profile.headWidth, (y - 1.43) / 0.21);
}

function depthAt(y: number, profile: BodyProfile): number {
    if (y < 0.82) return profile.hips;
    if (y < 1.08) return blend(profile.hips, profile.bellyDepth, (y - 0.82) / 0.26);
    if (y < 1.3) return blend(profile.bellyDepth, profile.chestDepth, (y - 1.08) / 0.22);
    return blend(profile.chestDepth, profile.headWidth, (y - 1.3) / 0.34);
}

function deform(point: Vector3, profile: BodyProfile): Vector3 {
    const y = point.y;
    const height = y < HIP_Y
        ? y * profile.leg
        : y < NECK_Y
            ? HIP_Y * profile.leg + (y - HIP_Y) * profile.torso
            : HIP_Y * profile.leg + (NECK_Y - HIP_Y) * profile.torso + (y - NECK_Y) * profile.headHeight;
    const width = widthAt(y, profile);
    const armBlend = Math.min(1, Math.max(0, (Math.abs(point.x) - 0.28) / 0.17));
    const horizontal = blend(width, profile.arms, armBlend);
    const depth = depthAt(y, profile);
    return point.set(point.x * horizontal, height, point.z * depth);
}

/** Reshape a private clone of the CC0 body and its rest skeleton together. Never mutate the shared GLB source. */
export function reshapeDirectorQuaterniusActor(root: Object3D, preset: DirectorActorPresetId): void {
    const profile = BODY_PROFILES[preset];
    if (!profile) return;
    root.updateMatrixWorld(true);
    const rootToWorld = root.matrixWorld.clone();
    const worldToRoot = rootToWorld.clone().invert();
    const bones: Bone[] = [];
    const originalBonePositions = new Map<Bone, Vector3>();
    const meshes: SkinnedMesh[] = [];
    root.traverse((object) => {
        if (object instanceof Bone) {
            bones.push(object);
            originalBonePositions.set(object, object.getWorldPosition(new Vector3()).applyMatrix4(worldToRoot));
        }
        if (object instanceof SkinnedMesh) meshes.push(object);
    });

    for (const mesh of meshes) {
        const geometry = mesh.geometry.clone();
        const positions = geometry.getAttribute("position");
        const meshToWorld = mesh.matrixWorld.clone();
        const worldToMesh = meshToWorld.clone().invert();
        const point = new Vector3();
        for (let index = 0; index < positions.count; index += 1) {
            point.fromBufferAttribute(positions, index).applyMatrix4(meshToWorld).applyMatrix4(worldToRoot);
            deform(point, profile).applyMatrix4(rootToWorld).applyMatrix4(worldToMesh);
            positions.setXYZ(index, point.x, point.y, point.z);
        }
        positions.needsUpdate = true;
        geometry.computeVertexNormals();
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        mesh.geometry = geometry;
    }

    for (const bone of bones) {
        const original = originalBonePositions.get(bone)!;
        const parentInverse = bone.parent?.matrixWorld.clone().invert() ?? new Matrix4();
        bone.position.copy(deform(original.clone(), profile).applyMatrix4(rootToWorld).applyMatrix4(parentInverse));
        bone.updateMatrixWorld(true);
    }
    root.updateMatrixWorld(true);
    for (const skeleton of new Set(meshes.map((mesh) => mesh.skeleton))) skeleton.calculateInverses();
}
