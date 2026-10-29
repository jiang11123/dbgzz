import { expect, test } from "bun:test";
import { AnimationClip, AnimationMixer, Bone, Box3, Group, Quaternion, QuaternionKeyframeTrack, Vector3, VectorKeyframeTrack } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { readFileSync } from "node:fs";

import { applyDirectorBoneTracks, inferDirectorRig, resolveDirectorActorPoseDeltas, resolveDirectorActorVisualUrl } from "../src/components/canvas/director/director-viewport";
import { restoreDirectorPoseRigRest } from "../src/lib/canvas/director/director-pose-rig";
import { createDirectorActor } from "../src/lib/canvas/director/director-scene";
import type { DirectorHumanoidBone, DirectorObject, DirectorPose } from "../src/types/director";
import { DIRECTOR_QUATERNIUS_FEMALE_URL, DIRECTOR_QUATERNIUS_MALE_URL } from "../src/lib/canvas/director/director-actor-assets";

test("Quaternius 的下划线骨骼名称能映射到导演台四肢控制", () => {
    const root = new Group();
    for (const name of [
        "root", "pelvis", "spine_01", "spine_02", "neck_01", "Head",
        "upperarm_l", "lowerarm_l", "hand_l", "upperarm_r", "lowerarm_r", "hand_r",
        "thigh_l", "calf_l", "foot_l", "thigh_r", "calf_r", "foot_r",
    ]) {
        const bone = new Bone();
        bone.name = name;
        root.add(bone);
    }
    const rig = inferDirectorRig(root, []);
    expect(rig.status).toBe("ready");
    expect(rig.boneMap.leftUpperArm).toBe("upperarm_l");
    expect(rig.boneMap.rightUpperArm).toBe("upperarm_r");
    expect(rig.boneMap.leftLowerArm).toBe("lowerarm_l");
    expect(rig.boneMap.rightLowerArm).toBe("lowerarm_r");
    expect(rig.boneMap.leftUpperLeg).toBe("thigh_l");
    expect(rig.boneMap.rightUpperLeg).toBe("thigh_r");
    expect(rig.boneMap.leftFoot).toBe("foot_l");
    expect(rig.boneMap.rightFoot).toBe("foot_r");
});

test("旧场景无 URL 人体演员显示内置模型，几何模型和显式 URL 保持原样", () => {
    const oldMale = { ...createDirectorActor(), url: undefined };
    expect(resolveDirectorActorVisualUrl(oldMale)).toBe(DIRECTOR_QUATERNIUS_MALE_URL);
    expect(resolveDirectorActorVisualUrl({ ...oldMale, actorPreset: "standard_female" })).toBe(DIRECTOR_QUATERNIUS_FEMALE_URL);
    expect(resolveDirectorActorVisualUrl({ ...oldMale, actorPreset: "slim" })).toBe(DIRECTOR_QUATERNIUS_MALE_URL);
    expect(resolveDirectorActorVisualUrl({ ...oldMale, actorPreset: "geometric" })).toBeNull();
    expect(resolveDirectorActorVisualUrl({ ...oldMale, url: "/my-own-actor.glb" })).toBe("/my-own-actor.glb");
});

test("Quaternius 的站立姿势镜像左上臂局部旋转，旧演员保持原逻辑", () => {
    const original = { ...createDirectorActor(), url: "/my-own-actor.glb" };
    const model = { ...original, url: "/canvas/models/quaternius-standard-male.glb" };
    const standard = resolveDirectorActorPoseDeltas(original);
    const adapted = resolveDirectorActorPoseDeltas(model);
    expect(adapted.leftUpperArm).toEqual(new Quaternion(...standard.leftUpperArm!).invert().toArray());
    expect(adapted.rightUpperArm).toEqual(standard.rightUpperArm);
    expect(adapted.leftUpperArm).not.toEqual(standard.leftUpperArm);
});

for (const body of ["male", "female"] as const) test(`实际 Quaternius ${body} 网格的站立姿势使两只手都低于肩`, async () => {
    const source = readFileSync(new URL(`../public/canvas/models/quaternius-standard-${body}.glb`, import.meta.url));
    const parsed = await new Promise<{ scene: Group }>((resolve, reject) => {
        new GLTFLoader().parse(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength), "", resolve, reject);
    });
    const root = parsed.scene;
    const pose = resolveDirectorActorPoseDeltas({ ...createDirectorActor(), url: body === "male" ? DIRECTOR_QUATERNIUS_MALE_URL : DIRECTOR_QUATERNIUS_FEMALE_URL });
    for (const [side, delta] of [["l", pose.leftUpperArm], ["r", pose.rightUpperArm]] as const) {
        const shoulder = root.getObjectByName(`upperarm_${side}`)!;
        const hand = root.getObjectByName(`hand_${side}`)!;
        shoulder.quaternion.multiply(new Quaternion(...delta!));
        root.updateMatrixWorld(true);
        expect(hand.getWorldPosition(new Bone().position).y).toBeLessThan(shoulder.getWorldPosition(new Bone().position).y);
    }
});

async function loadPoseActor(body: "male" | "female") {
    const source = readFileSync(new URL(`../public/canvas/models/quaternius-standard-${body}.glb`, import.meta.url));
    const model = (await new GLTFLoader().parseAsync(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength), "")).scene;
    const space = new Group();
    space.add(model);
    model.updateWorldMatrix(true, true);
    const size = new Box3().setFromObject(model, true).getSize(new Vector3());
    model.scale.multiplyScalar(2 / Math.max(size.x, size.y, size.z));
    model.updateWorldMatrix(true, true);
    const bounds = new Box3().setFromObject(model, true);
    const center = bounds.getCenter(new Vector3());
    model.position.sub(center);
    model.position.y -= bounds.min.y - center.y;
    model.updateWorldMatrix(true, true);
    model.userData.directorRestHeight = new Box3().setFromObject(model, true).getSize(new Vector3()).y;
    const rig = inferDirectorRig(model, []);
    const rotations = Object.fromEntries(Object.entries(rig.boneMap).map(([key, name]) => [key, model.getObjectByName(name!)!.quaternion.toArray()])) as Record<string, [number, number, number, number]>;
    const positions = Object.fromEntries(Object.entries(rig.boneMap).map(([key, name]) => [key, model.getObjectByName(name!)!.position.toArray()])) as Record<string, [number, number, number]>;
    const bone = (name: DirectorHumanoidBone) => model.getObjectByName(rig.boneMap[name]!)!;
    const point = (name: DirectorHumanoidBone) => space.worldToLocal(bone(name).getWorldPosition(new Vector3()));
    const actor = { ...createDirectorActor(), url: body === "male" ? DIRECTOR_QUATERNIUS_MALE_URL : DIRECTOR_QUATERNIUS_FEMALE_URL };
    const apply = (pose: DirectorPose, time = 0, layers: Partial<DirectorObject> = {}) => applyDirectorBoneTracks(model, { ...actor, pose, ...layers }, time, rig, rotations, positions, false);
    return { model, space, rig, rotations, positions, bone, point, apply };
}

const repairedPoses: DirectorPose[] = ["run", "squat", "kneel_single", "kneel_double", "bow", "think", "fight", "kick", "reach", "arms_crossed", "phone"];
for (const body of ["male", "female"] as const) {
    test(`实际 ${body} 蹲跪姿势沿角色竖直方向降低骨盆，膝盖和支撑脚接地`, async () => {
        const { point, apply } = await loadPoseActor(body);
        apply("stand");
        const standingHip = point("hips");
        const ankleHeight = point("leftFoot").y;
        apply("squat");
        expect(point("hips").y).toBeLessThan(standingHip.y - 0.25);
        expect(Math.abs(point("hips").z - standingHip.z)).toBeLessThan(0.15);
        expect(point("leftFoot").y).toBeCloseTo(ankleHeight, 4);
        expect(point("rightFoot").y).toBeCloseTo(ankleHeight, 4);
        apply("kneel_double");
        expect(point("leftLowerLeg").y).toBeLessThan(0.12);
        expect(point("rightLowerLeg").y).toBeLessThan(0.12);
        expect(point("leftLowerLeg").y).toBeGreaterThan(0.04);
        apply("kneel_single");
        expect(point("leftLowerLeg").y).toBeLessThan(0.12);
        expect(point("rightLowerLeg").y).toBeGreaterThan(0.2);
        apply("bow");
        expect(point("head").z).toBeGreaterThan(standingHip.z + 0.3);
        expect(point("rightHand").y).toBeLessThan(point("chest").y - 0.2);
        expect(point("rightHand").z).toBeGreaterThan(point("hips").z);
        expect(Math.abs(point("leftFoot").y - ankleHeight)).toBeLessThan(0.03);
        expect(Math.abs(point("rightFoot").y - ankleHeight)).toBeLessThan(0.03);
    });

    test(`实际 ${body} 的接触手势、抬脚和跑步相位在正确侧生效`, async () => {
        const { point, apply, bone, rotations } = await loadPoseActor(body);
        apply("phone");
        expect(point("leftHand").x).toBeGreaterThan(point("rightHand").x);
        expect(point("leftHand").distanceTo(point("rightHand"))).toBeLessThan(0.2);
        expect(point("rightHand").z).toBeGreaterThan(point("chest").z + 0.15);
        apply("think");
        expect(point("rightHand").distanceTo(point("head"))).toBeLessThan(0.35);
        apply("arms_crossed");
        expect(point("leftHand").x).toBeLessThan(0);
        expect(point("rightHand").x).toBeGreaterThan(0);
        expect(Math.abs(point("leftHand").z - point("rightHand").z)).toBeGreaterThan(0.025);
        for (const side of ["left", "right"] as const) {
            const fingerDirection = point(`${side}Middle1`).sub(point(`${side}Hand`)).normalize();
            // Fingers must wrap back toward the opposite arm, rather than fan out sideways.
            expect(fingerDirection.z).toBeLessThan(-0.35);
            expect(Math.abs(point(`${side}Hand`).x)).toBeLessThan(0.12);
        }
        apply("fight");
        expect(point("rightHand").y).toBeGreaterThan(1.2);
        expect(bone("rightIndex2").quaternion.angleTo(new Quaternion(...rotations.rightIndex2))).toBeGreaterThan(0.4);
        apply("reach");
        expect(point("rightHand").z).toBeGreaterThan(0.3);
        apply("kick");
        expect(point("rightFoot").y).toBeGreaterThan(0.25);
        expect(point("rightFoot").z).toBeGreaterThan(0.6);
        expect(point("leftFoot").y).toBeLessThan(0.15);
        apply("run", 0);
        const start = point("leftFoot");
        apply("run", 0.4);
        expect(start.y - point("leftFoot").y).toBeGreaterThan(0.15);
        apply("run", 0.8);
        expect(point("leftFoot").distanceTo(start)).toBeLessThan(1e-5);
    });

    test(`实际 ${body} 的 11 个预设保持骨长，反复切换和整体变换不漂移`, async () => {
        const { point, apply, space } = await loadPoseActor(body);
        const chains = [["leftUpperArm", "leftLowerArm", "leftHand"], ["rightUpperArm", "rightLowerArm", "rightHand"], ["leftUpperLeg", "leftLowerLeg", "leftFoot"], ["rightUpperLeg", "rightLowerLeg", "rightFoot"]] as const;
        const lengths = chains.map(([a, b, c]) => [point(a).distanceTo(point(b)), point(b).distanceTo(point(c))]);
        apply("stand");
        const standingHip = point("hips");
        for (const pose of repairedPoses) {
            apply(pose);
            chains.forEach(([a, b, c], index) => {
                expect(point(a).distanceTo(point(b))).toBeCloseTo(lengths[index][0], 5);
                expect(point(b).distanceTo(point(c))).toBeCloseTo(lengths[index][1], 5);
                expect(point(c).toArray().every(Number.isFinite)).toBe(true);
            });
        }
        apply("phone");
        const wrist = point("rightHand");
        space.position.set(3, 1, -2);
        space.rotation.set(0.2, 0.8, -0.15);
        space.scale.set(1.3, 0.8, 1.1);
        for (let index = 0; index < 3; index++) apply("phone");
        expect(point("rightHand").distanceTo(wrist)).toBeLessThan(1e-5);
        apply("stand");
        expect(point("hips").distanceTo(standingHip)).toBeLessThan(1e-5);
    });

    test(`实际 ${body} 的手动骨骼和关键帧始终覆盖预设求解结果`, async () => {
        const { point, apply, bone } = await loadPoseActor(body);
        apply("phone");
        const wrist = point("rightHand");
        const override: [number, number, number, number] = [0, 0, 0, 1];
        apply("phone", 0, { boneOverrides: { rightHand: override } });
        expect(bone("rightHand").quaternion.toArray()).toEqual(override);
        expect(point("rightHand").distanceTo(wrist)).toBeLessThan(1e-5);
        const keyed = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.4).toArray() as [number, number, number, number];
        apply("phone", 0, { boneOverrides: { rightHand: override }, boneTracks: [{ bone: "rightHand", keyframes: [{ id: "pose-key", time: 0, rotation: keyed }] }] });
        expect(bone("rightHand").quaternion.angleTo(new Quaternion(...keyed))).toBeLessThan(1e-6);
    });
}

test("切入只驱动一条手臂的动画前，跪姿的骨盆和未被动画覆盖的骨骼恢复静置", async () => {
    const { model, rig, apply, bone, rotations, positions } = await loadPoseActor("male");
    apply("kneel_double");
    restoreDirectorPoseRigRest(model);
    expect(bone("hips").position.toArray()).toEqual(positions.hips);
    expect(bone("leftLowerLeg").quaternion.toArray()).toEqual(rotations.leftLowerLeg);
    const restArm = rotations.rightUpperArm;
    const nextArm = new Quaternion(...restArm).multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.4)).toArray();
    const clip = new AnimationClip("arm-only", 1, [
        new QuaternionKeyframeTrack(`${bone("rightUpperArm").name}.quaternion`, [0, 1], [...restArm, ...nextArm]),
        new VectorKeyframeTrack(`${bone("hips").name}.position`, [0, 1], [0, 0.2, 0, 0, 0.2, 0]),
    ]);
    const mixer = new AnimationMixer(model);
    mixer.clipAction(clip).play();
    mixer.setTime(0.5);
    const animated = bone("rightUpperArm").quaternion.clone();
    applyDirectorBoneTracks(model, { ...createDirectorActor(), pose: "kneel_double" }, 0.5, rig, rotations, positions, true);
    expect(bone("rightUpperArm").quaternion.angleTo(animated)).toBeLessThan(1e-6);
    expect(bone("hips").position.y).toBeCloseTo(0.2, 6);
    for (const time of [0.5, 0.6, 0.6, 0.7]) {
        mixer.setTime(time);
        applyDirectorBoneTracks(model, { ...createDirectorActor(), pose: "kneel_double" }, time, rig, rotations, positions, true);
        expect(bone("hips").position.y).toBeCloseTo(0.2, 6);
    }
    mixer.stopAllAction();
    mixer.uncacheRoot(model);
});
