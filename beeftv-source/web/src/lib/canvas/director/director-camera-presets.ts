import { Euler, Vector3 } from "three";

import { createDirectorCamera, directorFocalLengthToFov } from "@/lib/canvas/director/director-scene";
import type { DirectorCamera, DirectorTransform, DirectorVec3 } from "@/types/director";

export const DIRECTOR_CAMERA_PRESETS = [
    { id: "current", label: "当前视角", offset: [0, 0, 0], focalLength: 35 },
    { id: "front-medium", label: "正面中景", offset: [0, 0.2, 4.5], focalLength: 50 },
    { id: "front-close", label: "正面特写", offset: [0, 0.25, 2.1], focalLength: 70 },
    { id: "front-wide", label: "正面全景", offset: [0, 1.2, 9], focalLength: 28 },
    { id: "side-follow", label: "侧面跟拍", offset: [4.5, 0.2, -1.3], focalLength: 50 },
    { id: "side-close", label: "侧面近景", offset: [2.2, 0.2, -0.3], focalLength: 70 },
    { id: "back-medium", label: "背面中景", offset: [0, 0.2, -4.5], focalLength: 50 },
    { id: "top-wide", label: "俯拍全景", offset: [0, 8, 3], focalLength: 28 },
    { id: "top-45", label: "45° 俯拍", offset: [0, 5, 5], focalLength: 35 },
    { id: "low-up", label: "低角度仰拍", offset: [0, -0.7, 3.3], focalLength: 50 },
    { id: "low-wide", label: "低角度广角", offset: [0, -0.6, 5], focalLength: 24 },
    { id: "shoulder-left", label: "过肩镜头", offset: [-0.9, 0.1, -1.3], focalLength: 50 },
    { id: "shoulder-right", label: "过肩镜头（右）", offset: [0.9, 0.1, -1.3], focalLength: 50 },
    { id: "bird-eye", label: "鸟瞰", offset: [0, 12, 0.05], focalLength: 28 },
    { id: "dutch", label: "荷兰角", offset: [0, 0.2, 4.5], focalLength: 50 },
] as const;

export type DirectorCameraPresetId = typeof DIRECTOR_CAMERA_PRESETS[number]["id"];

export function createDirectorCameraFromPreset(input: {
    presetId: DirectorCameraPresetId;
    name: string;
    target: DirectorVec3;
    /** Rotate relative shot presets with the subject's world yaw. */
    subjectYaw?: number;
    currentView?: DirectorTransform | null;
    followTarget?: { objectId: string; position: DirectorVec3 };
}): DirectorCamera {
    const preset = DIRECTOR_CAMERA_PRESETS.find((item) => item.id === input.presetId) ?? DIRECTOR_CAMERA_PRESETS[0];
    const camera = createDirectorCamera(input.name);
    if (preset.id === "current" && input.currentView) {
        const direction = new Vector3(0, 0, -1).applyEuler(new Euler(...input.currentView.rotation)).multiplyScalar(5);
        const position = input.currentView.position;
        return {
            ...camera,
            transform: { ...camera.transform, position: [...position], rotation: [...input.currentView.rotation] },
            target: [position[0] + direction.x, position[1] + direction.y, position[2] + direction.z],
        };
    }
    const offset = new Vector3(...preset.offset).applyAxisAngle(new Vector3(0, 1, 0), input.subjectYaw || 0);
    const position: DirectorVec3 = [input.target[0] + offset.x, input.target[1] + offset.y, input.target[2] + offset.z];
    const rotation: DirectorVec3 = preset.id === "dutch" ? [0, 0, Math.PI / 8] : [0, 0, 0];
    return {
        ...camera,
        transform: { ...camera.transform, position, rotation },
        target: [...input.target],
        focalLength: preset.focalLength,
        fov: directorFocalLengthToFov(preset.focalLength),
        ...(preset.id === "side-follow" && input.followTarget ? {
            followObjectId: input.followTarget.objectId,
            followAnchor: [...input.followTarget.position],
            lookAtMode: "object" as const,
            lookAtObjectId: input.followTarget.objectId,
        } : {}),
    };
}
