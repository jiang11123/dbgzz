import { Vector3 } from "three";

import type { DirectorHumanoidBone, DirectorPose, DirectorVec3 } from "@/types/director";

export type DirectorPoseTargets = {
    /** Character-local translation added to the rest pelvis, in units per 1.8 m actor. */
    pelvisOffset: DirectorVec3;
    hands?: Partial<Record<"leftHand" | "rightHand", DirectorVec3>>;
    feet?: Partial<Record<"leftFoot" | "rightFoot", DirectorVec3>>;
    /** Ground contacts for kneeling; other knees follow the two-bone solver. */
    knees?: Partial<Record<"leftKnee" | "rightKnee", DirectorVec3>>;
    torso?: Partial<Record<"hips" | "spine" | "chest" | "neck" | "head", DirectorVec3>>;
    handStyle?: "relaxed" | "chin" | "guard" | "reach" | "crossed" | "phone";
    elbowPoles: Partial<Record<"leftUpperArm" | "rightUpperArm", DirectorVec3>>;
    kneePoles: Partial<Record<"leftUpperLeg" | "rightUpperLeg", DirectorVec3>>;
    /** Present only for a cyclic pose whose phase is driven by the shot playhead. */
    period?: number;
};

const vec = (x: number, y: number, z: number): DirectorVec3 => [x, y, z];
const staticTargets = (partial: Partial<DirectorPoseTargets> = {}): DirectorPoseTargets => ({
    pelvisOffset: vec(0, 0, 0),
    elbowPoles: { leftUpperArm: vec(-0.3, -1, 0.15), rightUpperArm: vec(0.3, -1, 0.15) },
    kneePoles: { leftUpperLeg: vec(-0.1, 0, 1), rightUpperLeg: vec(0.1, 0, 1) },
    ...partial,
});

/** Resolve authored end-effector targets in a ground-origin character space (1.8 units tall). */
export function resolveDirectorPoseTargets(pose: DirectorPose, timeSeconds = 0): DirectorPoseTargets {
    if (pose === "run") {
        const period = 0.8;
        const phase = ((timeSeconds % period) + period) % period / period * Math.PI * 2 + Math.PI / 2;
        const stride = Math.sin(phase);
        const depth = Math.cos(phase);
        const leftLift = Math.max(0, stride);
        const rightLift = Math.max(0, -stride);
        return staticTargets({
            period,
            pelvisOffset: vec(0, -0.015 + Math.sin(phase * 2) * 0.018, 0),
            feet: {
                leftFoot: vec(-0.11, 0.035 + leftLift * 0.2, 0.08 + depth * 0.16),
                rightFoot: vec(0.11, 0.035 + rightLift * 0.2, 0.08 - depth * 0.16),
            },
            torso: { hips: vec(0.13, 0, 0), spine: vec(0.15, 0, 0), chest: vec(0.15, 0, 0), neck: vec(0.04, 0, 0), head: vec(0.02, 0, 0) },
            handStyle: "guard",
            elbowPoles: { leftUpperArm: vec(-0.3, -0.2, -1), rightUpperArm: vec(0.3, -0.2, -1) },
            hands: {
                leftHand: vec(-0.17, 1.25 + depth * 0.12, 0.15 - stride * 0.18),
                rightHand: vec(0.17, 1.25 - depth * 0.12, 0.15 + stride * 0.18),
            },
        });
    }

    const poses: Partial<Record<DirectorPose, DirectorPoseTargets>> = {
        squat: staticTargets({
            pelvisOffset: vec(0, -0.34, -0.07),
            torso: { hips: vec(0.2, 0, 0), spine: vec(0.14, 0, 0), chest: vec(0.1, 0, 0), neck: vec(0, 0, 0), head: vec(0, 0, 0) },
            feet: { leftFoot: vec(-0.12, 0.035, 0.04), rightFoot: vec(0.12, 0.035, 0.04) },
        }),
        kneel_single: staticTargets({
            pelvisOffset: vec(0, -0.53, 0),
            knees: { leftKnee: vec(-0.11, 0.065, 0.08) },
            feet: { leftFoot: vec(-0.11, 0.035, -0.33), rightFoot: vec(0.13, 0.035, 0.33) },
        }),
        kneel_double: staticTargets({
            pelvisOffset: vec(0, -0.55, 0),
            knees: { leftKnee: vec(-0.11, 0.065, 0.02), rightKnee: vec(0.11, 0.065, 0.02) },
            feet: { leftFoot: vec(-0.11, 0.035, -0.38), rightFoot: vec(0.11, 0.035, -0.38) },
        }),
        bow: staticTargets({
            pelvisOffset: vec(0, 0, -0.04),
            hands: { leftHand: vec(-0.2, 0.84, 0.25), rightHand: vec(0.2, 0.84, 0.25) },
            handStyle: "relaxed",
            torso: { hips: vec(0.35, 0, 0), spine: vec(0.6, 0, 0), chest: vec(0.72, 0, 0), neck: vec(0.76, 0, 0), head: vec(0.82, 0, 0) },
        }),
        think: staticTargets({ hands: { rightHand: vec(0.07, 1.46, 0.15) }, torso: { head: vec(0.1, -0.12, 0) }, handStyle: "chin" }),
        fight: staticTargets({
            torso: { hips: vec(0.04, 0.12, 0), spine: vec(0.04, 0.16, 0), chest: vec(0.04, 0.2, 0), head: vec(0, 0, 0) },
            handStyle: "guard",
            hands: { leftHand: vec(-0.22, 1.34, 0.22), rightHand: vec(0.22, 1.34, 0.22) },
            feet: { leftFoot: vec(-0.13, 0.035, 0.16), rightFoot: vec(0.14, 0.035, -0.16) },
        }),
        kick: staticTargets({
            hands: { leftHand: vec(-0.45, 1.1, -0.08), rightHand: vec(0.38, 1.1, -0.15) },
            handStyle: "relaxed",
            torso: { hips: vec(-0.08, 0, 0), spine: vec(-0.1, 0, 0), chest: vec(-0.08, 0, 0), head: vec(0, 0, 0) },
            feet: { leftFoot: vec(-0.13, 0.035, 0.02), rightFoot: vec(0.15, 0.28, 0.8) },
        }),
        reach: staticTargets({ hands: { rightHand: vec(0.26, 1.3, 0.43) }, torso: { chest: vec(0, 0.1, 0) }, handStyle: "reach" }),
        arms_crossed: staticTargets({
            // Leave room for the palm/fingers to wrap onto the opposite upper arm.
            hands: { leftHand: vec(0.08, 1.24, 0.16), rightHand: vec(-0.08, 1.29, 0.21) },
            elbowPoles: { leftUpperArm: vec(-1, -0.5, 0.2), rightUpperArm: vec(1, -0.5, 0.2) },
            handStyle: "crossed",
        }),
        phone: staticTargets({ hands: { leftHand: vec(-0.065, 1.14, 0.28), rightHand: vec(0.065, 1.14, 0.28) }, torso: { neck: vec(0.1, 0, 0), head: vec(0.42, 0, 0) }, handStyle: "phone" }),
    };
    return poses[pose] || staticTargets();
}

/** Find the elbow/knee point of a two-bone chain, clamping unreachable endpoints to its reach. */
export function resolveDirectorTwoBoneJoint(start: DirectorVec3, end: DirectorVec3, upperLength: number, lowerLength: number, pole: DirectorVec3): DirectorVec3 {
    const origin = new Vector3(...start);
    const endpoint = new Vector3(...end);
    const upper = Math.max(1e-5, upperLength);
    const lower = Math.max(1e-5, lowerLength);
    const vector = endpoint.clone().sub(origin);
    const rawDistance = vector.length();
    const direction = rawDistance > 1e-5 ? vector.multiplyScalar(1 / rawDistance) : new Vector3(0, -1, 0);
    const minimum = Math.abs(upper - lower) + 1e-5;
    const maximum = upper + lower - 1e-5;
    const distance = Math.max(minimum, Math.min(maximum, rawDistance));
    const projectedPole = new Vector3(...pole).addScaledVector(direction, -new Vector3(...pole).dot(direction));
    if (projectedPole.lengthSq() < 1e-8) {
        projectedPole.set(1, 0, 0).addScaledVector(direction, -direction.x);
        if (projectedPole.lengthSq() < 1e-8) projectedPole.set(0, 0, 1).addScaledVector(direction, -direction.z);
    }
    projectedPole.normalize();
    const along = (upper * upper + distance * distance - lower * lower) / (2 * distance);
    const height = Math.sqrt(Math.max(0, upper * upper - along * along));
    return origin.addScaledVector(direction, along).addScaledVector(projectedPole, height).toArray() as DirectorVec3;
}

/** Convert an end-effector chain name to the end and middle bone names used by the solver. */
export function directorPoseChainBones(end: "leftHand" | "rightHand" | "leftFoot" | "rightFoot") {
    const side = end.startsWith("left") ? "left" : "right";
    return end.endsWith("Hand")
        ? { upper: `${side}UpperArm` as DirectorHumanoidBone, middle: `${side}LowerArm` as DirectorHumanoidBone, end: end as DirectorHumanoidBone }
        : { upper: `${side}UpperLeg` as DirectorHumanoidBone, middle: `${side}LowerLeg` as DirectorHumanoidBone, end: end as DirectorHumanoidBone };
}

/** These presets use actor-space targets instead of rig-specific Euler deltas. */
export function hasDirectorSolvedPose(pose: DirectorPose) {
    return ["run", "squat", "kneel_single", "kneel_double", "bow", "think", "fight", "kick", "reach", "arms_crossed", "phone"].includes(pose);
}
