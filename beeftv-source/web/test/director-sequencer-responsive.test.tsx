import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DirectorSequencer } from "../src/components/canvas/director/director-sequencer";
import { createDirectorReproActorScene, createDirectorReproScene } from "../src/lib/canvas/director/director-repro-fixture";
import { createDirectorActorPath } from "../src/lib/canvas/director/director-actor-paths";
import { createDirectorCameraPathKeyframes } from "../src/lib/canvas/director/director-camera-paths";

describe("导演台时间轴窄窗口布局", () => {
    test("未建路线的人物和主机位都在一级轨道提供可点击的绘制入口", () => {
        const scene = createDirectorReproActorScene();
        const shot = scene.shots[0];
        const html = renderToStaticMarkup(createElement(DirectorSequencer, {
            scene, shot, camera: scene.cameras[0], objects: scene.objects,
            selectedObjectId: null, selectedBone: null, playhead: 0, playing: false, autoKey: false, height: 300, visible: true,
            onPlayToggle: () => {}, onPlayheadChange: () => {}, onAutoKeyChange: () => {}, onHeightChange: () => {}, onVisibilityChange: () => {},
            onSelectObject: () => {}, onSelectBone: () => {}, onRecordKeyframe: () => {}, onAddShot: () => {}, onDeleteKeyframe: () => {}, onSetKeyframeEasing: () => {}, onSelectShot: () => {},
        }));
        expect(html).toContain('aria-label="绘制演员 1轨迹"');
        expect(html).toContain('aria-label="绘制主机位轨迹"');
        expect(html).toContain('aria-label="展开演员 1属性"');
        expect(html).not.toContain('data-director-object-channel="position"');
        expect(html).not.toContain("director-sequencer-channel-label");
    });

    test("路线完成后人物与机位展开二级轨道，每个控制帧有可选锚点", () => {
        const scene = createDirectorReproActorScene();
        const shot = scene.shots[0];
        const actor = createDirectorActorPath(scene.objects[0], "line", shot.duration);
        const camera = { ...scene.cameras[0], keyframes: createDirectorCameraPathKeyframes("line", scene.cameras[0], shot.duration) };
        const html = renderToStaticMarkup(createElement(DirectorSequencer, {
            scene, shot, camera, objects: [actor], selectedObjectId: null, selectedBone: null,
            playhead: 0, playing: false, autoKey: false, height: 300, visible: true,
            onPlayToggle: () => {}, onPlayheadChange: () => {}, onAutoKeyChange: () => {}, onHeightChange: () => {}, onVisibilityChange: () => {},
            onSelectObject: () => {}, onSelectBone: () => {}, onRecordKeyframe: () => {}, onAddShot: () => {}, onDeleteKeyframe: () => {}, onSetKeyframeEasing: () => {}, onSelectShot: () => {},
        }));
        expect(html).toContain('aria-label="收起演员 1属性"');
        expect(html).toContain('aria-label="收起主机位属性"');
        expect(html).toContain('data-director-object-channel="position"');
        expect(html).toContain("焦点");
        expect(html).toContain("视角");
        expect(html).toContain('aria-label="选择 演员 1 位置 0.00s 的关键帧"');
        expect(html).toContain('aria-label="选择 机位1 位置 0.00s 的关键帧"');
    });
    test("紧凑时间轴保留所有已建对象轨道，不随机位选择消失", () => {
        const scene = createDirectorReproScene();
        const shot = scene.shots.find((item) => item.id === scene.activeShotId)!;
        const actor = scene.objects[0];
        const objects = [
            { ...actor, id: "track-actor-a", name: "轨道角色甲", animationTrackEnabled: true },
            { ...actor, id: "track-actor-b", name: "轨道角色乙", animationTrackEnabled: true },
        ];
        const html = renderToStaticMarkup(createElement(DirectorSequencer, {
            scene, shot, camera: scene.cameras.find((item) => item.id === shot.cameraId) || null,
            objects, selectedObjectId: null, selectedBone: null,
            playhead: 0, playing: false, autoKey: false, height: 130, visible: true,
            onPlayToggle: () => {}, onPlayheadChange: () => {}, onAutoKeyChange: () => {},
            onHeightChange: () => {}, onVisibilityChange: () => {}, onSelectObject: () => {}, onSelectBone: () => {},
            onRecordKeyframe: () => {}, onAddShot: () => {}, onDeleteKeyframe: () => {}, onSetKeyframeEasing: () => {}, onSelectShot: () => {},
        }));
        expect(html).toContain("轨道角色甲");
        expect(html).toContain("轨道角色乙");
        expect(html).toContain("主机位");
    });

    test("展开时间轴只增加可见高度，并受视口高度约束", () => {
        const scene = createDirectorReproScene();
        const shot = scene.shots.find((item) => item.id === scene.activeShotId)!;
        const html = renderToStaticMarkup(createElement(DirectorSequencer, {
            scene, shot, camera: scene.cameras.find((item) => item.id === shot.cameraId) || null,
            objects: scene.objects, selectedObjectId: null, selectedBone: null,
            playhead: 0, playing: false, autoKey: false, height: 300, visible: true,
            onPlayToggle: () => {}, onPlayheadChange: () => {}, onAutoKeyChange: () => {},
            onHeightChange: () => {}, onVisibilityChange: () => {}, onSelectObject: () => {}, onSelectBone: () => {},
            onRecordKeyframe: () => {}, onAddShot: () => {}, onDeleteKeyframe: () => {}, onSetKeyframeEasing: () => {}, onSelectShot: () => {},
        }));
        expect(html).toContain("height:300px");
        expect(html).toContain("max-height:60vh");
        expect(html).toContain('data-presentation="compact"');
        expect(html).toContain('aria-label="收起时间轴"');
    });

    test("主机位在缩略与展开时间轴中使用同一概览样式和轨迹操作", () => {
        const scene = createDirectorReproScene();
        const shot = scene.shots.find((item) => item.id === scene.activeShotId)!;
        const camera = scene.cameras.find((item) => item.id === shot.cameraId)!;
        const render = (height: number) => renderToStaticMarkup(createElement(DirectorSequencer, {
            scene, shot, camera, objects: scene.objects, selectedObjectId: null, selectedBone: null,
            playhead: 0, playing: false, autoKey: false, height, visible: true,
            onPlayToggle: () => {}, onPlayheadChange: () => {}, onAutoKeyChange: () => {},
            onHeightChange: () => {}, onVisibilityChange: () => {}, onSelectObject: () => {}, onSelectBone: () => {},
            onRecordKeyframe: () => {}, onAddShot: () => {}, onDeleteKeyframe: () => {}, onSetKeyframeEasing: () => {}, onSelectShot: () => {},
        }));
        const compact = render(130);
        const expanded = render(300);

        expect(compact).toContain('data-presentation="compact"');
        expect(compact).toContain('aria-label="展开时间轴"');
        expect(expanded).toContain('data-presentation="compact"');
        expect(expanded).toContain('aria-label="收起时间轴"');
        for (const markup of [compact, expanded]) {
            expect(markup).toContain("director-sequencer-compact-grid");
            expect(markup).toContain("director-sequencer-main-label is-camera");
            expect(markup).toContain('aria-label="绘制主机位轨迹"');
            expect(markup).not.toContain("镜头总轨");
            expect(markup).not.toContain("Camera Cut");
            expect(markup).not.toContain('aria-label="当前镜头"');
        }
    });

    test("成片预演显示紧凑播放底栏与单条片段轨道，隐藏动画编辑工具", () => {
        const scene = createDirectorReproScene();
        const shot = scene.shots.find((item) => item.id === scene.activeShotId)!;
        const html = renderToStaticMarkup(createElement(DirectorSequencer, {
            scene, shot, camera: scene.cameras.find((item) => item.id === shot.cameraId) || null,
            objects: scene.objects, selectedObjectId: null, selectedBone: null,
            playhead: 0, playing: false, autoKey: false, height: 300, visible: true, presentation: "preview",
            onPlayToggle: () => {}, onPlayheadChange: () => {}, onAutoKeyChange: () => {},
            onHeightChange: () => {}, onVisibilityChange: () => {}, onSelectObject: () => {}, onSelectBone: () => {},
            onRecordKeyframe: () => {}, onAddShot: () => {}, onDeleteKeyframe: () => {}, onSetKeyframeEasing: () => {}, onSelectShot: () => {},
        }));

        expect(html).toContain("director-sequencer-preview-time");
        expect(html).toContain('aria-label="时间线缩放"');
        expect(html).toContain('aria-label="预演时间线"');
        expect(html).toContain('aria-label="新增镜头"');
        expect(html).not.toContain('title="自动关键帧"');
        expect(html).not.toContain('title="吸附到帧"');
        expect(html).not.toContain('title="记录当前关键帧"');
        expect(html).not.toContain('aria-label="显示子轨道"');
        expect(html).not.toContain('class="director-sequencer-resizer"');
    });
});
