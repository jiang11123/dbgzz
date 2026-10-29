import { SkeletonHelper, type Object3D } from "three";

/** Mounted beside the model, inside the same actor transform group. */
export class DirectorSkeletonHelper extends SkeletonHelper {
    constructor(model: Object3D) {
        super(model);
        // SkeletonHelper 默认绑定世界矩阵；作为模型兄弟节点时须使用局部矩阵，
        // 否则角色父组的位移、旋转与缩放会被重复应用。
        this.matrix = model.matrix;
    }

    override updateMatrixWorld(force?: boolean) {
        // 姿态 effect 可先于渲染器遍历触发，先更新完整骨架再采样线段端点。
        this.root.updateWorldMatrix(true, true);
        super.updateMatrixWorld(force);
    }
}

/** Editor aids are visible in the workbench, never in captured frames or video. */
export function suspendDirectorEditorOverlays(scene: Object3D): () => void {
    const previous: Array<{ object: Object3D; visible: boolean }> = [];
    scene.traverse((object) => {
        // drei mounts the TransformControls Object3D separately from its JSX group.
        // Its `isTransformControls` flag is therefore the reliable capture-time marker.
        if (object.userData.directorEditorOnly !== true && (object as Object3D & { isTransformControls?: boolean }).isTransformControls !== true) return;
        previous.push({ object, visible: object.visible });
        object.visible = false;
    });
    return () => {
        for (const item of previous) item.object.visible = item.visible;
    };
}
