import { Box3, Euler, Matrix4, Object3D, Quaternion, Vector3 } from "three";

import { directorPoseChainBones, hasDirectorSolvedPose, resolveDirectorPoseTargets, resolveDirectorTwoBoneJoint } from "@/lib/canvas/director/director-pose-solving";
import type { DirectorHumanoidBone, DirectorPose, DirectorRig, DirectorVec3 } from "@/types/director";

type EndBone = "leftHand" | "rightHand" | "leftFoot" | "rightFoot";
type HandBasis = { fingers: Vector3; palm: Vector3 };
type PoseRig = {
    bones: Partial<Record<DirectorHumanoidBone, Object3D>>;
    positions: Partial<Record<DirectorHumanoidBone, Vector3>>;
    rotations: Partial<Record<DirectorHumanoidBone, Quaternion>>;
    hands: Partial<Record<"leftHand" | "rightHand", HandBasis>>;
    localPositions: Partial<Record<DirectorHumanoidBone, Vector3>>;
    localRotations: Partial<Record<DirectorHumanoidBone, Quaternion>>;
    height: number;
    mirrorX: number;
};
const profiles = new WeakMap<Object3D, PoseRig>();
const vector = (point: DirectorVec3) => new Vector3(...point);
const tuple = (point: Vector3) => point.toArray() as DirectorVec3;

function actorPoint(model: Object3D, bone: Object3D) {
    const point = bone.getWorldPosition(new Vector3());
    return model.parent ? model.parent.worldToLocal(point) : point;
}
function actorRotation(model: Object3D, bone: Object3D) {
    bone.updateWorldMatrix(true, false);
    const matrix = bone.matrixWorld.clone();
    if (model.parent) matrix.premultiply(model.parent.matrixWorld.clone().invert());
    return new Quaternion().setFromRotationMatrix(matrix.extractRotation(matrix));
}
function setActorRotation(model: Object3D, bone: Object3D, rotation: Quaternion) {
    const parent = bone.parent ? actorRotation(model, bone.parent) : new Quaternion();
    bone.quaternion.copy(parent.invert().multiply(rotation));
    bone.updateWorldMatrix(false, true);
}
function setActorPosition(model: Object3D, bone: Object3D, position: Vector3) {
    const world = model.parent ? model.parent.localToWorld(position.clone()) : position.clone();
    bone.position.copy(bone.parent ? bone.parent.worldToLocal(world) : world);
    bone.updateWorldMatrix(false, true);
}

/** Capture the unposed rig in character space, before mixer, preset, or user edits. */
export function prepareDirectorPoseRig(model: Object3D, rig: DirectorRig, height?: number) {
    const existing = profiles.get(model);
    if (existing) return existing;
    model.updateWorldMatrix(true, true);
    const bones: PoseRig["bones"] = {};
    const positions: PoseRig["positions"] = {};
    const rotations: PoseRig["rotations"] = {};
    const localPositions: PoseRig["localPositions"] = {};
    const localRotations: PoseRig["localRotations"] = {};
    for (const [key, name] of Object.entries(rig.boneMap)) {
        const bone = name ? model.getObjectByName(name) : null;
        if (!bone) continue;
        const keyName = key as DirectorHumanoidBone;
        bones[keyName] = bone;
        localPositions[keyName] = bone.position.clone();
        localRotations[keyName] = bone.quaternion.clone();
        positions[keyName] = actorPoint(model, bone);
        rotations[keyName] = actorRotation(model, bone);
    }
    const left = positions.leftUpperLeg?.x ?? positions.leftUpperArm?.x ?? -1;
    const right = positions.rightUpperLeg?.x ?? positions.rightUpperArm?.x ?? 1;
    const hands: PoseRig["hands"] = {};
    for (const side of ["left", "right"] as const) {
        const hand = positions[`${side}Hand`];
        const forearm = positions[`${side}LowerArm`];
        if (!hand || !forearm) continue;
        const middle = positions[`${side}Middle1`];
        const index = positions[`${side}Index1`];
        const pinky = positions[`${side}Pinky1`];
        const fingers = (middle || hand.clone().add(hand.clone().sub(forearm))).clone().sub(hand).normalize();
        const palm = index && pinky
            ? fingers.clone().cross(index.clone().sub(pinky)).multiplyScalar(side === "left" ? 1 : -1).normalize()
            : new Vector3(side === "left" ? 1 : -1, 0, 0);
        hands[`${side}Hand`] = { fingers, palm };
    }
    const measuredHeight = height || model.userData.directorRestHeight || new Box3().setFromObject(model, true).getSize(new Vector3()).y;
    const profile: PoseRig = { bones, positions, rotations, hands, localPositions, localRotations, height: Math.max(0.1, measuredHeight), mirrorX: left > right ? -1 : 1 };
    profiles.set(model, profile);
    return profile;
}

/** Restore before starting a clip, including bones for which that clip has no tracks. */
export function restoreDirectorPoseRigRest(model: Object3D) {
    const profile = profiles.get(model);
    if (!profile) return;
    for (const [key, bone] of Object.entries(profile.bones)) {
        const name = key as DirectorHumanoidBone;
        if (profile.localPositions[name]) bone!.position.copy(profile.localPositions[name]!);
        if (profile.localRotations[name]) bone!.quaternion.copy(profile.localRotations[name]!);
    }
    model.updateWorldMatrix(true, true);
}

/** Rotate in the bone parent's space so armature axis/scale does not leak into IK. */
function aimBone(model: Object3D, bone: Object3D, child: Object3D, target: Vector3) {
    model.updateWorldMatrix(true, true);
    const worldTarget = model.parent ? model.parent.localToWorld(target.clone()) : target.clone();
    const childWorld = child.getWorldPosition(new Vector3());
    const localTarget = bone.parent ? bone.parent.worldToLocal(worldTarget) : worldTarget;
    const localChild = bone.parent ? bone.parent.worldToLocal(childWorld) : childWorld;
    const from = localChild.sub(bone.position);
    const to = localTarget.sub(bone.position);
    if (from.lengthSq() < 1e-10 || to.lengthSq() < 1e-10) return;
    bone.quaternion.premultiply(new Quaternion().setFromUnitVectors(from.normalize(), to.normalize()));
    bone.updateWorldMatrix(false, true);
}

function basisRotation(from: HandBasis, to: HandBasis) {
    const basis = ({ fingers, palm }: HandBasis) => {
        const y = fingers.clone().normalize();
        const z = palm.clone().addScaledVector(y, -palm.dot(y)).normalize();
        const x = y.clone().cross(z).normalize();
        return new Matrix4().makeBasis(x, y, z);
    };
    return new Quaternion().setFromRotationMatrix(basis(to).multiply(basis(from).invert()));
}

/** Shared solver for imported rigs and the offline mannequin; user layers run afterwards. */
export function applyDirectorRigPose(model: Object3D, rig: DirectorRig, pose: DirectorPose, timeSeconds: number) {
    if (!hasDirectorSolvedPose(pose)) return;
    const profile = profiles.get(model) || prepareDirectorPoseRig(model, rig);
    const targets = resolveDirectorPoseTargets(pose, timeSeconds);
    const scale = profile.height / 1.8;
    const point = (value: DirectorVec3) => vector(value).multiply(new Vector3(profile.mirrorX * scale, scale, scale));
    const direction = (value: DirectorVec3) => vector(value).multiply(new Vector3(profile.mirrorX, 1, 1)).normalize();
    const pelvis = profile.bones.hips;
    if (pelvis) setActorPosition(model, pelvis, actorPoint(model, pelvis).add(point(targets.pelvisOffset)));

    // Absolute deltas in character space keep the spine/neck bend independent of
    // each model's local rest axes. Hierarchy order is essential here.
    for (const boneName of ["hips", "spine", "chest", "neck", "head"] as const) {
        const angle = targets.torso?.[boneName];
        const bone = profile.bones[boneName];
        const rest = profile.rotations[boneName];
        if (!angle || !bone || !rest) continue;
        const delta = new Quaternion().setFromEuler(new Euler(angle[0], angle[1] * profile.mirrorX, angle[2] * profile.mirrorX));
        setActorRotation(model, bone, delta.multiply(rest));
    }
    model.updateWorldMatrix(true, true);

    // Put a kneeling thigh exactly one bone-length from the knee contact, rather
    // than stretching the thigh or accepting a floating knee at an arbitrary height.
    if (pelvis && targets.knees) {
        const corrections: number[] = [];
        for (const side of ["left", "right"] as const) {
            const knee = targets.knees[`${side}Knee`];
            const upper = profile.bones[`${side}UpperLeg`];
            const middle = profile.bones[`${side}LowerLeg`];
            if (!knee || !upper || !middle) continue;
            const start = actorPoint(model, upper);
            const contact = point(knee);
            const length = start.distanceTo(actorPoint(model, middle));
            const horizontal = (start.x - contact.x) ** 2 + (start.z - contact.z) ** 2;
            corrections.push(contact.y + Math.sqrt(Math.max(0, length * length - horizontal)) - start.y);
        }
        if (corrections.length) {
            const position = actorPoint(model, pelvis);
            position.y += corrections.reduce((sum, correction) => sum + correction, 0) / corrections.length;
            setActorPosition(model, pelvis, position);
        }
    }

    const solve = (end: EndBone, target: Vector3, kneeContact?: Vector3) => {
        const chain = directorPoseChainBones(end);
        const upper = profile.bones[chain.upper];
        const middle = profile.bones[chain.middle];
        const terminal = profile.bones[end];
        if (!upper || !middle || !terminal) return;
        const start = actorPoint(model, upper);
        const joint = actorPoint(model, middle);
        const finish = actorPoint(model, terminal);
        const upperLength = start.distanceTo(joint);
        const lowerLength = joint.distanceTo(finish);
        if (kneeContact) {
            // Shins lie behind the knee and keep their original length. The small
            // ankle lift leaves room for the instep instead of burying the foot.
            target.copy(kneeContact).add(new Vector3(0, scale * 0.025, -Math.sqrt(Math.max(0, lowerLength ** 2 - (scale * 0.025) ** 2))));
        }
        const distance = target.distanceTo(start);
        if (!kneeContact && distance > upperLength + lowerLength - 1e-5) target.sub(start).setLength(upperLength + lowerLength - 1e-5).add(start);
        const pole = end.endsWith("Hand")
            ? targets.elbowPoles[chain.upper as "leftUpperArm" | "rightUpperArm"] || [0, -1, 0.3]
            : targets.kneePoles[chain.upper as "leftUpperLeg" | "rightUpperLeg"] || [0, 0, 1];
        const middleTarget = kneeContact || vector(resolveDirectorTwoBoneJoint(tuple(start), tuple(target), upperLength, lowerLength, tuple(direction(pole))));
        aimBone(model, upper, middle, middleTarget);
        aimBone(model, middle, terminal, target);
    };

    for (const side of ["left", "right"] as const) {
        const end = `${side}Foot` as const;
        const rest = profile.positions[end];
        if (!rest) continue;
        const authored = targets.feet?.[end];
        const target = authored ? point(authored) : rest.clone();
        if (authored) {
            target.y += rest.y - 0.035 * scale;
            target.z += rest.z;
        }
        const knee = targets.knees?.[`${side}Knee`];
        solve(end, target, knee ? point(knee) : undefined);
        const bone = profile.bones[end];
        const rotation = profile.rotations[end];
        if (bone && rotation) {
            const delta = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), knee ? 2.55 : 0);
            setActorRotation(model, bone, delta.multiply(rotation));
        }
    }

    for (const side of ["left", "right"] as const) {
        const end = `${side}Hand` as const;
        const authored = targets.hands?.[end];
        if (!authored) continue;
        solve(end, point(authored));
        const hand = profile.bones[end];
        const restRotation = profile.rotations[end];
        const restBasis = profile.hands[end];
        if (!hand || !restRotation || !restBasis) continue;
        const style = targets.handStyle;
        const fingers = style === "relaxed" ? direction([0, -1, 0]) : style === "crossed" ? direction([side === "left" ? 1 : -1, 0.1, -0.8])
            : style === "reach" ? direction([0, 0, 1]) : direction([0, 1, 0]);
        const palm = style === "relaxed" ? direction([side === "left" ? 1 : -1, 0, 0]) : style === "reach" ? direction([0, -1, 0]) : direction([0, 0, -1]);
        const handDelta = basisRotation(restBasis, { fingers, palm });
        setActorRotation(model, hand, handDelta.clone().multiply(restRotation));
        const curl = style === "guard" ? 1.15 : style === "chin" ? 0.45 : style === "phone" ? 0.3 : style === "crossed" ? 0.45 : style === "relaxed" ? 0.1 : 0;
        const across = fingers.clone().cross(palm).normalize();
        for (const finger of ["Thumb", "Index", "Middle", "Ring", "Pinky"] as const) {
            for (const segment of [1, 2, 3] as const) {
                const name = `${side}${finger}${segment}` as DirectorHumanoidBone;
                const bone = profile.bones[name];
                const rest = profile.rotations[name];
                if (!bone || !rest) continue;
                const angle = curl * (finger === "Thumb" ? 0.35 : 0.8) * segment;
                const rotation = new Quaternion().setFromAxisAngle(across, angle).multiply(handDelta).multiply(rest);
                setActorRotation(model, bone, rotation);
            }
        }
    }
    model.updateWorldMatrix(true, true);
}
