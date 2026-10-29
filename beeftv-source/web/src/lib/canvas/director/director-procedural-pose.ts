import { Bone, Group, Quaternion, Vector3 } from "three";

import { resolveDirectorBoneRotation } from "@/lib/canvas/director/director-animation-semantics";
import { directorPoseBoneDeltas } from "@/lib/canvas/director/director-scene";
import { hasDirectorSolvedPose } from "@/lib/canvas/director/director-pose-solving";
import { applyDirectorRigPose, prepareDirectorPoseRig } from "@/lib/canvas/director/director-pose-rig";
import type { DirectorActorShape } from "@/lib/canvas/director/director-actor-presets";
import type { DirectorHumanoidBone, DirectorObject, DirectorPose, DirectorQuat, DirectorRig, DirectorVec3 } from "@/types/director";

type JointDefinition = { bone: DirectorHumanoidBone; parent: DirectorHumanoidBone | null; offset: DirectorVec3 };

const JOINTS: JointDefinition[] = [
    { bone: "root", parent: null, offset: [0, 0, 0] },
    { bone: "hips", parent: "root", offset: [0, 0.78, 0] },
    { bone: "spine", parent: "hips", offset: [0, 0.22, 0] },
    { bone: "chest", parent: "spine", offset: [0, 0.16, 0] },
    { bone: "neck", parent: "chest", offset: [0, 0.24, 0] },
    { bone: "head", parent: "neck", offset: [0, 0.22, 0] },
    { bone: "leftShoulder", parent: "chest", offset: [-0.2, 0.08, 0] },
    { bone: "leftUpperArm", parent: "leftShoulder", offset: [-0.04, -0.02, 0] },
    { bone: "leftLowerArm", parent: "leftUpperArm", offset: [-0.07, -0.3, 0] },
    { bone: "leftHand", parent: "leftLowerArm", offset: [-0.02, -0.3, 0] },
    { bone: "rightShoulder", parent: "chest", offset: [0.2, 0.08, 0] },
    { bone: "rightUpperArm", parent: "rightShoulder", offset: [0.04, -0.02, 0] },
    { bone: "rightLowerArm", parent: "rightUpperArm", offset: [0.07, -0.3, 0] },
    { bone: "rightHand", parent: "rightLowerArm", offset: [0.02, -0.3, 0] },
    { bone: "leftUpperLeg", parent: "hips", offset: [-0.11, -0.02, 0] },
    { bone: "leftLowerLeg", parent: "leftUpperLeg", offset: [-0.03, -0.35, 0] },
    { bone: "leftFoot", parent: "leftLowerLeg", offset: [0, -0.35, 0.08] },
    { bone: "rightUpperLeg", parent: "hips", offset: [0.11, -0.02, 0] },
    { bone: "rightLowerLeg", parent: "rightUpperLeg", offset: [0.03, -0.35, 0] },
    { bone: "rightFoot", parent: "rightLowerLeg", offset: [0, -0.35, 0.08] },
];

export const DIRECTOR_PROCEDURAL_ACTOR_BONES = JOINTS.map(({ bone }) => bone);
/** Parent-child links shared by the lightweight mannequin's visible rig overlay. */
export const DIRECTOR_PROCEDURAL_ACTOR_SKELETON_EDGES = JOINTS.flatMap(({ bone, parent }) => parent ? [[parent, bone] as const] : []);

/** Evaluate the lightweight local mannequin from the same pose and bone-override data as imported rigs. */
export function resolveDirectorProceduralActorPose(pose: DirectorPose, overrides: Partial<Record<DirectorHumanoidBone, DirectorQuat>> = {}, shape?: DirectorActorShape, timeSeconds = 0, tracks: DirectorObject["boneTracks"] = []) {
    const poseDeltas = { ...directorPoseBoneDeltas(hasDirectorSolvedPose(pose) ? "stand" : pose) };
    // This mannequin already rests with hanging arms; imported rigs rest in T pose.
    const soldierStand = directorPoseBoneDeltas("stand");
    for (const bone of ["leftUpperArm", "rightUpperArm"] as const) {
        const poseRotation = poseDeltas[bone];
        const standRotation = soldierStand[bone];
        if (poseRotation && standRotation && poseRotation.every((value, index) => Math.abs(value - standRotation[index]) < 1e-6)) delete poseDeltas[bone];
    }
    const model = new Group();
    const bones = {} as Record<DirectorHumanoidBone, Bone>;
    for (const { bone, parent, offset } of JOINTS) {
        const node = new Bone();
        node.name = bone;
        const adjustedOffset = [...offset] as DirectorVec3;
        if (shape) {
            if (bone === "hips") adjustedOffset[1] *= shape.legLength;
            else if (bone === "spine" || bone === "chest" || bone === "neck" || bone === "head") adjustedOffset[1] *= shape.torsoLength;
            else if (bone.includes("Shoulder") || bone.includes("Arm") || bone.includes("Hand")) {
                adjustedOffset[0] *= shape.armSpan;
                adjustedOffset[1] *= bone.includes("Shoulder") ? shape.torsoLength : shape.armLength;
            } else if (bone.includes("Leg") || bone.includes("Foot")) {
                adjustedOffset[0] *= shape.stance;
                adjustedOffset[1] *= shape.legLength;
                if (bone.includes("Foot")) adjustedOffset[2] *= shape.footLength;
            }
        }
        node.position.fromArray(adjustedOffset);
        bones[bone] = node;
        (parent ? bones[parent] : model).add(node);
    }
    model.updateWorldMatrix(true, true);
    const rig: DirectorRig = {
        status: "ready", animationNames: [],
        boneMap: Object.fromEntries(JOINTS.map(({ bone }) => [bone, bone])),
    };
    const height = bones.head.getWorldPosition(new Vector3()).y + 0.02 * (shape?.head || 1);
    prepareDirectorPoseRig(model, rig, height);
    for (const { bone } of JOINTS) {
        if (poseDeltas[bone]) bones[bone].quaternion.fromArray(poseDeltas[bone]!);
    }
    applyDirectorRigPose(model, rig, pose, timeSeconds);
    for (const { bone } of JOINTS) {
        const rotation = resolveDirectorBoneRotation({ override: overrides[bone], keyframes: tracks?.find((track) => track.bone === bone)?.keyframes, time: timeSeconds });
        if (rotation) bones[bone].quaternion.fromArray(rotation);
    }
    model.updateWorldMatrix(true, true);
    const joints = {} as Record<DirectorHumanoidBone, DirectorVec3>;
    const rotations = {} as Record<DirectorHumanoidBone, DirectorQuat>;
    const worldRotations = {} as Record<DirectorHumanoidBone, DirectorQuat>;
    for (const { bone } of JOINTS) {
        joints[bone] = bones[bone].getWorldPosition(new Vector3()).toArray() as DirectorVec3;
        rotations[bone] = bones[bone].quaternion.toArray() as DirectorQuat;
        worldRotations[bone] = bones[bone].getWorldQuaternion(new Quaternion()).toArray() as DirectorQuat;
    }
    return { joints, rotations, worldRotations };
}
