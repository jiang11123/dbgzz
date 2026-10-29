import { describe, expect, it } from "bun:test";
import { Group, Mesh, MeshBasicMaterial, SphereGeometry } from "three";

import { directorPanoramaSphere, suspendDirectorPanoramaSphere } from "../src/lib/canvas/director/director-panorama-sphere";
import { createDirectorScene } from "../src/lib/canvas/director/director-scene";

describe("导演台全景球", () => {
    it("keeps defaults and supports old panorama rotation", () => {
        const scene = createDirectorScene();
        expect(directorPanoramaSphere(scene)).toEqual({ radius: 60, rotation: 0 });
        delete scene.panoramaRotation;
        delete scene.panoramaRadius;
        scene.panorama = { url: "blob:old", rotation: 35 };
        expect(directorPanoramaSphere(scene)).toEqual({ radius: 60, rotation: 35 });
        scene.panoramaRotation = 270;
        scene.panoramaRadius = 120;
        expect(directorPanoramaSphere(scene)).toEqual({ radius: 120, rotation: 270 });
    });

    it("hides only panorama geometry for non-beauty passes and restores prior visibility", () => {
        const root = new Group();
        const ordinary = new Mesh(new SphereGeometry(), new MeshBasicMaterial());
        const panorama = new Mesh(new SphereGeometry(), new MeshBasicMaterial());
        panorama.userData.directorPanoramaSphere = true;
        root.add(ordinary, panorama);
        const restore = suspendDirectorPanoramaSphere(root);
        expect(panorama.visible).toBe(false);
        expect(ordinary.visible).toBe(true);
        restore();
        expect(panorama.visible).toBe(true);
        panorama.visible = false;
        suspendDirectorPanoramaSphere(root)();
        expect(panorama.visible).toBe(false);
        ordinary.geometry.dispose();
        panorama.geometry.dispose();
        (ordinary.material as MeshBasicMaterial).dispose();
        (panorama.material as MeshBasicMaterial).dispose();
    });
});
