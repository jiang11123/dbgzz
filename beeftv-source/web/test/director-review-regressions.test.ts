import { expect, test } from "bun:test";
import { createDirectorActor, createDirectorCamera, createDirectorScene, directorIdentityTransform, duplicateDirectorCamera, duplicateDirectorObject } from "@/lib/canvas/director/director-scene";
import { createDirectorActorPath, updateDirectorActorPathTransform } from "@/lib/canvas/director/director-actor-paths";
import { recordDirectorCameraPositionAtTime } from "@/lib/canvas/director/director-camera-paths";
import { resolveDirectorCameraGizmoEdit, resolveDirectorMultiObjectGroupTransformEdit, resolveDirectorMultiObjectTransformEdit } from "@/lib/canvas/director/director-animation-semantics";
import { resolveDirectorCameraLocalFraming, resolveDirectorCameraTransform } from "@/lib/canvas/director/director-view-modes";
import { replaceDirectorSceneObjects } from "@/lib/canvas/director/director-camera-binding";
import { directorAsyncSession } from "@/lib/canvas/director/director-async-session";
import { getActiveUserScope, setActiveUserScope } from "@/lib/user-scope";
import { userScopeMatches, UserScopeAbandonedError } from "@/lib/user-scope-guard";

function switchScope(userId: string) {
    const previous = getActiveUserScope();
    setActiveUserScope(userId);
    return () => setActiveUserScope(previous);
}

test("复制轨迹后控制点引用属于副本，可独立编辑和撤销轨迹", () => {
    const actor = createDirectorActorPath(createDirectorActor(), "ring", 5);
    const clone = duplicateDirectorObject(actor);
    expect(clone.motionPath!.controlKeyframeIds).toEqual([clone.keyframes[0].id, clone.keyframes[16].id, clone.keyframes[32].id]);
    expect(clone.motionPath!.controlKeyframeIds!.some((id) => actor.keyframes.some((frame) => frame.id === id))).toBe(false);
    const camera = createDirectorCamera();
    camera.keyframes = structuredClone(actor.keyframes);
    camera.drawnPath = { kind: "ring", sampleKeyframeIds: actor.keyframes.map((frame) => frame.id), originalKeyframes: [actor.keyframes[0]] };
    const cameraClone = duplicateDirectorCamera(camera);
    expect(cameraClone.drawnPath!.sampleKeyframeIds).toEqual(cameraClone.keyframes.map((frame) => frame.id));
    expect(cameraClone.drawnPath!.originalKeyframes![0].id).not.toBe(camera.keyframes[0].id);
});

test("只有位置轨道的相机也能用 gizmo 旋转并保持到实际取景", () => {
    const camera = recordDirectorCameraPositionAtTime(createDirectorCamera(), 0, 0);
    const from = resolveDirectorCameraTransform(camera, 0);
    const next = resolveDirectorCameraGizmoEdit({ camera, from, edited: { ...from, rotation: [0, 1, 0] }, rawTime: 0, snappedTime: 0 });
    expect(next.keyframes[0].rotationKeyed).toBe(true);
    expect(resolveDirectorCameraTransform(next, 0).rotation[1]).toBeCloseTo(1);
    const moved = resolveDirectorCameraGizmoEdit({ camera, from, edited: { ...from, position: [1, 2, 3] }, rawTime: 0, snappedTime: 0 });
    expect(moved.keyframes[0].rotationKeyed).toBe(false);
});

test("多选平移后轨迹中心同步，后续缩放围绕新中心", () => {
    const actor = createDirectorActorPath(createDirectorActor(), "ring", 5);
    const moved = resolveDirectorMultiObjectTransformEdit({ objects: [actor], selectedIds: [actor.id], representativeId: actor.id, from: actor.transform, to: { ...actor.transform, position: [10, 0, 0] }, autoKey: false, time: 0 })[0];
    expect(moved.motionPath!.transform.position).toEqual([8, 0, 0]);
    const scaled = updateDirectorActorPathTransform(moved, { ...moved.motionPath!.transform, scale: [2, 2, 2] });
    expect(scaled.keyframes[0].transform.position).toEqual([12, 0, 0]);
});

test("组旋转缩放同时变换整条轨迹与中心，AutoKey 不移动轨迹中心", () => {
    const actor = createDirectorActorPath(createDirectorActor(), "ring", 5);
    const args = { objects: [actor], selectedIds: [actor.id], from: directorIdentityTransform(), to: { position: [10, 0, 0] as [number, number, number], rotation: [0, Math.PI / 2, 0] as [number, number, number], scale: [2, 2, 2] as [number, number, number] }, autoKey: false, time: 0 };
    const moved = resolveDirectorMultiObjectGroupTransformEdit(args)[0];
    expect(moved.motionPath!.transform.position[0]).toBeCloseTo(10);
    expect(moved.motionPath!.transform.position[2]).toBeCloseTo(4);
    expect(moved.keyframes[16].transform.position[2]).toBeCloseTo(8);
    expect(resolveDirectorMultiObjectGroupTransformEdit({ ...args, autoKey: true })[0].motionPath).toBe(actor.motionPath);
});

test("多选属性修改模型朝向或尺寸时，不伪造轨迹自身的旋转缩放", () => {
    const actor = createDirectorActorPath(createDirectorActor(), "ring", 5);
    const next = resolveDirectorMultiObjectTransformEdit({ objects: [actor], selectedIds: [actor.id], representativeId: actor.id, from: actor.transform, to: { ...actor.transform, rotation: [0, 1, 0], scale: [2, 2, 2] }, autoKey: false, time: 0 })[0];
    expect(next.motionPath!.transform).toEqual(actor.motionPath!.transform);
    expect(next.keyframes.map((key) => key.transform.position)).toEqual(actor.keyframes.map((key) => key.transform.position));
});

test("AI 替换前烘焙跟随和注视，不让摄影机突然跳回旧基准", () => {
    const scene = createDirectorScene();
    const actor = scene.objects[0];
    actor.transform.position = [5, 0, 0];
    scene.cameras[0] = { ...scene.cameras[0], followObjectId: actor.id, followAnchor: [0, 0, 0], lookAtMode: "object", lookAtObjectId: actor.id };
    const before = resolveDirectorCameraLocalFraming(scene, scene.cameras[0], 0);
    const next = replaceDirectorSceneObjects(scene, [createDirectorActor("新角色")], 0);
    const after = resolveDirectorCameraLocalFraming(next, next.cameras[0], 0);
    expect(after).toEqual(before);
    expect(next.cameras[0].transform.position[0]).toBeCloseTo(scene.cameras[0].transform.position[0] + 5);
    expect(next.cameras[0].followObjectId).toBeUndefined();
    expect(next.cameras[0].lookAtObjectId).toBeUndefined();
});

test("旧会话异步完成时关闭再打开同一场景也不会恢复写权限", async () => {
    const old = new AbortController();
    const operation = directorAsyncSession(old.signal);
    let resolve!: () => void;
    let writes = 0;
    const pending = new Promise<void>((done) => { resolve = done; }).then(() => { operation.assertCurrent(); writes++; });
    old.abort();
    const reopened = directorAsyncSession(new AbortController().signal);
    resolve();
    await expect(pending).rejects.toThrow("导演台会话已结束");
    expect(writes).toBe(0);
    expect(reopened.current()).toBe(true);
});

test("A→B→A 复用同一用户名时旧会话仍不能写入", async () => {
    const restore = switchScope("owner-a");
    try {
        const operation = directorAsyncSession(new AbortController().signal);
        const captured = operation.expectedScope;
        setActiveUserScope("owner-b");
        setActiveUserScope("owner-a");
        expect(getActiveUserScope()).toBe("owner-a");
        expect(operation.current()).toBe(false);
        expect(userScopeMatches(captured)).toBe(false);
        expect(() => operation.assertCurrent()).toThrow(UserScopeAbandonedError);
    } finally {
        restore();
    }
});
