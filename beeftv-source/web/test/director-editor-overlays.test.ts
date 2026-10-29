import { describe, expect, test } from "bun:test";
import { AnimationClip, AnimationMixer, Bone, Group, QuaternionKeyframeTrack, Vector3 } from "three";

import { DirectorSkeletonHelper, suspendDirectorEditorOverlays } from "@/lib/canvas/director/director-editor-overlays";

function skeletonFixture() {
    const scene = new Group(), actor = new Group(), visual = new Group(), model = new Group();
    const hips = new Bone(), knee = new Bone(), foot = new Bone();
    hips.name = "hips";
    knee.name = "knee";
    knee.position.set(0, -0.5, 0);
    foot.position.set(0, -0.5, 0.1);
    hips.add(knee); knee.add(foot); model.add(hips);
    model.position.set(0.2, 0.8, -0.1);
    model.scale.setScalar(0.7);
    const helper = new DirectorSkeletonHelper(model);
    scene.add(actor); actor.add(visual); visual.add(model, helper);
    return { scene, actor, model, knee, helper };
}

function expectSkeletonAligned(helper: DirectorSkeletonHelper) {
    const positions = helper.geometry.getAttribute("position");
    let index = 0;
    for (const bone of helper.bones) {
        if (!(bone.parent instanceof Bone)) continue;
        for (const endpoint of [bone, bone.parent]) {
            const actual = new Vector3().fromBufferAttribute(positions, index++).applyMatrix4(helper.matrixWorld);
            const expected = new Vector3().setFromMatrixPosition(endpoint.matrixWorld);
            expect(actual.distanceTo(expected)).toBeLessThan(0.00001);
        }
    }
}

describe("导演台编辑辅助层", () => {
    test("骨骼线随角色路径、旋转、非等比缩放及行走动画在同一帧对齐", () => {
        const { scene, actor, model, helper } = skeletonFixture();
        const mixer = new AnimationMixer(model);
        mixer.clipAction(new AnimationClip("walk", 1, [new QuaternionKeyframeTrack("knee.quaternion", [0, 1], [0, 0, 0, 1, Math.sin(0.4), 0, 0, Math.cos(0.4)])])).play();
        for (const time of [0, 0.2, 0.5, 0.9, 0.1, 0]) {
            actor.position.set(time * 4, time * 0.1, -time * 3);
            actor.rotation.set(0.1, time, 0.2);
            actor.scale.set(1.2, 0.8, 1.5);
            mixer.setTime(time);
            scene.updateMatrixWorld(true);
            expectSkeletonAligned(helper);
        }
        helper.dispose();
        mixer.stopAllAction(); mixer.uncacheRoot(model);
    });

    test("在场景遍历前刷新辅助线，也读取本帧角色及骨骼变换", () => {
        const { scene, actor, knee, helper } = skeletonFixture();
        scene.updateMatrixWorld(true);
        actor.position.set(3, 0, -2);
        knee.rotation.x = 0.6;
        helper.updateMatrixWorld(true);
        expectSkeletonAligned(helper);
        expect(knee.getWorldPosition(new Vector3()).x).toBeGreaterThan(3);
        expectSkeletonAligned(helper);
        helper.dispose();
    });

    test("截帧期间仅隐藏 editor-only 图形，恢复原始可见性", () => {
        const scene = new Group();
        const content = new Group();
        const visibleAid = new Group();
        const hiddenAid = new Group();
        const transformGizmo = Object.assign(new Group(), { isTransformControls: true });
        visibleAid.userData.directorEditorOnly = true;
        hiddenAid.userData.directorEditorOnly = true;
        hiddenAid.visible = false;
        scene.add(content, visibleAid, hiddenAid, transformGizmo);
        const resume = suspendDirectorEditorOverlays(scene);
        expect(content.visible).toBe(true);
        expect(visibleAid.visible).toBe(false);
        expect(hiddenAid.visible).toBe(false);
        expect(transformGizmo.visible).toBe(false);
        resume();
        expect(content.visible).toBe(true);
        expect(visibleAid.visible).toBe(true);
        expect(hiddenAid.visible).toBe(false);
        expect(transformGizmo.visible).toBe(true);
    });
});
