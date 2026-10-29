import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { useDirectorWorkbenchStore } from "../src/stores/canvas/use-director-workbench-store";

/**
 * 生产接线回归：新建直达空导演台，已有场景原样打开，模式切换安全清理。
 */
const workbench = readFileSync(resolve(import.meta.dir, "../src/components/canvas/director/canvas-director-workbench.tsx"), "utf8");
const dock = readFileSync(resolve(import.meta.dir, "../src/components/canvas/director/director-viewport-dock.tsx"), "utf8");
const viewport = readFileSync(resolve(import.meta.dir, "../src/components/canvas/director/director-viewport.tsx"), "utf8");
const hook = readFileSync(resolve(import.meta.dir, "../src/pages/canvas/use-canvas-director.ts"), "utf8");
const uploadHook = readFileSync(resolve(import.meta.dir, "../src/pages/canvas/use-canvas-upload.ts"), "utf8");
const project = readFileSync(resolve(import.meta.dir, "../src/pages/canvas/project.tsx"), "utf8");
const directorNodePanel = readFileSync(resolve(import.meta.dir, "../src/components/canvas/director/canvas-director-node-panel.tsx"), "utf8");
const store = readFileSync(resolve(import.meta.dir, "../src/stores/canvas/use-director-workbench-store.ts"), "utf8");
const styles = readFileSync(resolve(import.meta.dir, "../src/styles/globals.css"), "utf8");

function slice(source: string, from: string, to: string) {
    const start = source.indexOf(from);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = source.indexOf(to, start + from.length);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
}

describe("新建场景直达空导演台", () => {
    test("创建函数只接收画布位置并创建空场景", () => {
        expect(hook).toContain("const createDirectorShot = useCallback((position?: Position) => {");
        expect(hook).toContain('createDirectorSceneFromTemplate("empty", `镜头 ${shotIndex}`)');
        expect(hook).toContain("setDirectorNodeId(node.id);");
    });

    test("画布三个创建入口直接创建，右键入口传递点击位置", () => {
        expect(project).toContain("onOpenDirector: () => createDirectorShot()");
        expect(project).toContain("onOpenDirector={() => createDirectorShot()}");
        expect(project).toContain("onOpenDirector={(position) => createDirectorShot(position)}");
        expect(project).not.toContain("CanvasDirectorTemplateModal");
        expect(project).not.toContain("directorTemplateRequest");
    });

    test("新建导演台节点是独立类型且不声明视频生成输入", () => {
        expect(hook).toContain("createCanvasNode(CanvasNodeType.Director");
        expect(hook).toContain("node.title = directorTitle;");
        expect(hook).toContain("nextDirectorNodeIndex(nodesRef.current)");
        expect(hook).not.toContain('generationMode: "video"');
        expect(hook).not.toContain('videoEditOperation: "text_to_video"');
        expect(hook).not.toContain('composerContent: ""');
    });

});

describe("已有场景不触发模板选择", () => {
    test("openDirectorWorkbench 命中已存在场景时不建新场景、不弹模板", () => {
        const opener = slice(hook, "const openDirectorWorkbench = useCallback", "/** 每次保存都基于 store");
        // 只有找不到场景（孤儿节点修复）才补建。
        expect(opener).toContain("if (!scene) {");
        expect(opener).toContain('createDirectorSceneFromTemplate("empty"');
        expect(opener).not.toContain("setDirectorTemplateRequest");
    });

    test("节点不再承载生成提示词，场景生成入口留给后续导演台功能", () => {
        const opener = slice(hook, "const openDirectorWorkbench = useCallback", "/** 每次保存都基于 store");
        expect(opener).toContain("setDirectorNodeId(nodeId);");
        expect(opener).not.toContain("updateDirectorShotPrompt");
        expect(directorNodePanel).not.toContain("onPromptChange");
        expect(directorNodePanel).not.toContain("composerContent");
        expect(directorNodePanel).not.toContain("textarea");
    });

    test("孤儿修复用空场景兜底：用户没选过就不许塞演员", () => {
        const opener = slice(hook, "const openDirectorWorkbench = useCallback", "/** 每次保存都基于 store");
        expect(opener).not.toContain('createDirectorSceneFromTemplate("monologue"');
        expect(opener).not.toContain("createDirectorActor");
    });

    test("workbench 自身不含模板选择逻辑：打开已保存场景不改写内容", () => {
        expect(workbench).not.toContain("DIRECTOR_TEMPLATES");
        expect(workbench).not.toContain("createDirectorSceneFromTemplate");
    });
});

describe("导演台场景菜单的相机与灯光操作", () => {
    test("角色菜单按预设身份分组，不依赖旧版九预设的数组下标", () => {
        expect(workbench).not.toContain("DIRECTOR_ACTOR_PRESET_OPTIONS.slice(0, 8)");
        expect(workbench).not.toContain("DIRECTOR_ACTOR_PRESET_OPTIONS.slice(8)");
        expect(workbench).toContain('DIRECTOR_ACTOR_PRESET_OPTIONS.filter((preset) => preset.id !== "geometric")');
        expect(workbench).toContain('DIRECTOR_ACTOR_PRESET_OPTIONS.filter((preset) => preset.id === "geometric")');
    });
    test("添加菜单提供 LibTV 同类的机位、太阳光、点光源、聚光灯并接入真实创建逻辑", () => {
        const menu = slice(workbench, "const addObjectMenuItems:", "const addShot =");
        expect(menu).toContain('key: "camera"');
        expect(menu).toContain('addPresetCamera("current")');
        expect(menu).toContain('key: "sun"');
        expect(menu).toContain('addLight("directional", "太阳光"');
        expect(menu).toContain('key: "point-light"');
        expect(menu).toContain('addLight("point", "点光源"');
        expect(menu).toContain('key: "spotlight"');
        expect(menu).toContain('addLight("spot", "聚光灯"');
        expect(slice(workbench, "const addObject = (object:", "const addPrimitive =")).toContain('setMode(object.kind === "actor" ? "pose" : "layout")');
        expect(slice(workbench, "const addPresetCamera =", "const addLight =")).toContain('setMode("camera")');
        expect(slice(workbench, "const addLight =", "const addLightMenuItems:")).toContain('setMode("layout")');
    });
});

describe("LibTV 场景资产聚焦交互", () => {
    test("机位、对象、灯光场景树行都提供聚焦动作并调用视口取景控制", () => {
        expect(workbench).toContain("onFocus={() => focusSceneCamera(item.camera)}");
        expect(workbench).toContain("onFocus={() => focusSceneObject(item.object)}");
        expect(workbench).toContain("onFocus={() => focusSceneLight(item.light)}");
        expect(workbench).toContain("aria-label={`聚焦${label}`}");
        expect(viewport).toContain("focusOnPoint: (point: DirectorVec3, radius: number) => boolean");
        expect(viewport).toContain("controls.target.fromArray(frame.target)");
        expect(viewport).toContain('onViewModeChange?.("free")');
    });
});

describe("导演节点参考图入口", () => {
    test("导演台节点暂不显示上传与提示词框控件", () => {
        expect(directorNodePanel).not.toContain("onAddReference");
        expect(directorNodePanel).not.toContain("onRemoveReference");
        expect(directorNodePanel).not.toContain("场景描述");
        expect(uploadHook).toContain('imageInputRef.current.accept = "image/*";');
    });
});

describe("模式接线", () => {
    test("workbench 从 store 读 mode，并按 capabilities 派生显示", () => {
        expect(workbench).toContain("const mode = useDirectorWorkbenchStore((state) => state.mode);");
        expect(workbench).toContain("const capabilities = directorModeCapabilities(mode);");
    });

    test("动画模式把 Transform 轨迹接入视口，隐藏演员和零长度轨迹不显示", () => {
        expect(workbench).toContain("showMotionPaths={workspaceView === \"scene\" && sequencerVisible}");
        expect(viewport).toContain('object.visible && (object.kind === "actor" || object.primitive === "character")');
        expect(viewport).toContain("directorTransformPathLength(object.keyframes) > 0.001");
        expect(viewport).toContain("<Line points={displayedPoints}");
        expect(viewport).toContain("interpolateDirectorTransform(sorted[0].transform, sorted, playhead).position");
    });

    test("选中演员后可直接进入姿势控制，关键帧仍由动画能力单独把关", () => {
        const inspector = slice(workbench, "function ObjectInspector(", "function LightInspector(");
        expect(inspector).toContain("{isActor ? <>");
        expect(inspector).not.toContain("isActor && capabilities.bones ? <>");
        expect(inspector).toContain('role="tablist" aria-label="角色属性"');
        expect(inspector).toContain("directorProceduralPoseControlGroups");
        expect(inspector).toContain('data-director-pose-axis={label}');
        expect(inspector).toContain("axisDirections={axisDirections(axisIndex, direction)}");
        expect(inspector).toContain('{tab !== "motion" && capabilities.keyframes ? <>');
        expect(workbench).toContain('label: "手臂 — 肩"');
        expect(workbench).toContain('label: "腿部 — 髋"');
        expect(workbench).toContain('pairedSemanticAxes("leftLowerArm", "rightLowerArm", ["弯曲"], [0])');
        expect(workbench).toContain('pairedSemanticAxes("leftUpperArm", "rightUpperArm", ["前举", "外展", "扭转"], [0, 2, 1], [-1, -1, 1], [-1, 1, 1])');
        // motionClips 不得再作为放行条件：带动画的普通模型不是演员。
        expect(workbench).not.toContain('object.primitive === "character" || motionClips.length) ? <>');
    });

    test("站立预设复位全身姿态，逐骨骼重置不删除动画轨道", () => {
        const inspector = slice(workbench, "function ObjectInspector(", "function LightInspector(");
        expect(inspector).toContain('onClick={() => applyPose(option.value)}');
        expect(inspector).toContain('const applyPose = (pose: DirectorPose) => onUpdate({ pose, activeMotionClipId: undefined, boneOverrides: {} })');
        expect(inspector).toContain("delete boneOverrides[bone]");
        expect(inspector).toContain('aria-label={`重置骨骼 ${directorBoneLabel(bone)}`}');
        expect(inspector).not.toContain("boneTracks: []");
    });

    test("动作片段与骨骼入口解耦：任何带 Clip 的对象都能调播放速度/循环", () => {
        expect(workbench).toContain('{tab !== "motion" && motionClips.length ? <><Field label="动作片段">');
        const inspector = slice(workbench, "function ObjectInspector(", "function LightInspector(");
        expect(inspector).toContain('aria-label="动作开始时间"');
        expect(inspector).toContain("snapDirectorTime(value ?? 0, fps)");
        expect(workbench).toContain("fps={activeShot?.fps || 24} shotDuration={activeShot?.duration || 15}");
    });

    test("关键帧入口由 keyframes 把关", () => {
        expect(workbench).toContain('{tab !== "motion" && capabilities.keyframes ? <>');
    });

    test("渲染视图下拉按当前模式过滤，而不是写死五项", () => {
        expect(dock).toContain("renderModes: DirectorRenderMode[];");
        expect(dock).toContain("RENDER_VIEW_BUTTONS.filter((item) => renderModes.includes(item.mode))");
        expect(workbench).toContain("renderModes={capabilities.renderModes}");
    });

    test("dock 不是绕过模式门控的第二条路径：渲染视图按钮同样按 renderModes 过滤", () => {
        expect(dock).toContain("renderModes: DirectorRenderMode[];");
        expect(dock).toContain("RENDER_VIEW_BUTTONS.filter((item) => renderModes.includes(item.mode))");
        // 写死的按钮会绕过门控。
        expect(dock).not.toContain('onClick={() => onRenderModeChange("pose")}');
        expect(workbench).toContain("renderModes={capabilities.renderModes}");
    });

    test("store 层夹住 renderMode：任何路径都无法设置当前模式不允许的视图", () => {
        expect(store).toContain("setRenderMode: (renderMode) => set((state) => (directorModeCapabilities(state.mode).renderModes.includes(renderMode) ? { renderMode } : {})),");
    });

    test("摄影机模式固定显示 shot/camera 检查器", () => {
        expect(workbench).toContain("selectedObject && !capabilities.cameraTools ?");
        expect(workbench).toContain("selectedLight && !capabilities.cameraTools ?");
    });

    test("运镜生成只更新首尾帧并提示到动画模式继续编辑，不清空手工关键帧", () => {
        expect(workbench).toContain("resolveDirectorCameraMoveKeyframes(item.keyframes");
        expect(workbench).toContain("已更新运镜首尾关键帧，可在动画模式继续编辑");
        expect(workbench).not.toContain("keyframes: [{ id: nanoid(), time: 0, transform: start }");
    });

    test("小屏把属性检查器放到下方而不是隐藏，姿态与骨骼入口仍可达", () => {
        expect(workbench).toContain("max-lg:col-span-2 max-lg:max-h-[40vh] max-lg:border-l-0 max-lg:border-t");
        expect(workbench).not.toContain("border-l max-lg:hidden");
    });

    test("store 切离动画模式时停止播放、关闭 Auto Key，并夹回允许的渲染视图", () => {
        const directorStore = useDirectorWorkbenchStore;
        directorStore.getState().reset();
        directorStore.getState().setMode("animate");
        directorStore.getState().setRenderMode("pose");
        directorStore.getState().setPlaying(true);
        directorStore.getState().setAutoKey(true);
        directorStore.getState().setMode("layout");
        expect(directorStore.getState().playing).toBe(false);
        expect(directorStore.getState().autoKey).toBe(false);
        expect(directorStore.getState().renderMode).toBe("beauty");
        directorStore.getState().reset();
    });

    test("mode 不写进 DirectorScene：类型文件里没有 mode 字段", () => {
        const types = readFileSync(resolve(import.meta.dir, "../src/types/director.ts"), "utf8");
        const sceneType = slice(types, "export type DirectorScene = {", "};");
        expect(sceneType).not.toContain("mode");
    });

    test("切模式不重建会话：初始化 effect 的依赖里没有 mode", () => {
        const initEffect = slice(workbench, "// 会话初始化只认 scene id", "// 打开会话时检查合法本地恢复候选");
        // 依赖里出现 mode 就意味着换视图会 resetWorkbench + 清空 history。
        expect(initEffect).toContain("}, [open, resetWorkbench, scene, writeDraft]);");
        expect(initEffect).not.toContain("mode");
    });

    test("draft/history/save 的生命周期 effect 一律不依赖 mode", () => {
        // 逐个锁住依赖数组：任一处混入 mode，切模式就会掉草稿或掉历史。
        expect(workbench).toContain("}, [message, modal, open, scene, writeDraft]);");
        expect(workbench).toContain("}, [mirrorDraft, stagedTransaction]);");
        expect(workbench).toContain("}, [mirrorDraft]);");
        // 弹窗开关需暂停快捷键；mode 切换仍不得反复重挂监听器。
        expect(workbench).toContain("}, [open, panoramaAIOpen, panoramaHistoryOpen]);");
    });
});

describe("异步导演台输出使用最新权威状态", () => {
    test("上传后重新核验节点与场景，并把预览引用合入最新 scene", () => {
        expect(hook).toContain("const sourceNodeAtStart = nodesRef.current.find");
        expect(hook).toContain("const outputProjectId = projectId;");
        expect(hook).toContain("projectIdRef.current !== outputProjectId");
        expect(hook).toContain("const outputProject = useCanvasStore.getState().projects.find((item) => item.id === outputProjectId);");
        expect(hook).toContain("const sourceNode = nodesRef.current.find((item) => item.id === sourceNodeId);");
        expect(hook).toContain("const latestScene = outputProject?.directorScenes.find");
        expect(hook).toContain("mergeDirectorOutputPreview(latestScene");
        const assetRegistration = hook.indexOf("for (const mediaNode of mediaNodes)");
        const commitValidation = hook.indexOf("const commitProject =", assetRegistration);
        expect(assetRegistration).toBeGreaterThan(0);
        expect(commitValidation).toBeGreaterThan(assetRegistration);
        expect(hook.slice(commitValidation)).toContain("isDirectorOutputTargetCurrent(");
        expect(hook.slice(commitValidation)).toContain("const committedNodes = [...nodesRef.current]");
        expect(hook).toContain("saveDirectorScene(committedScene);");
        expect(hook).not.toContain("saveDirectorScene({ ...output.scene");
        expect(hook).toContain("uploadImage(output.beauty, undefined, expectedScope)");
        expect(hook).toContain('uploadMediaFile(output.clayVideo, "director-clay", undefined, expectedScope)');
        expect(hook).toContain("ensureCanvasNodeAsset({ canvasId: projectId, domainProjectId, node: mediaNode, source: \"canvas-manual\", expectedScope })");
        expect(hook).toContain("if (!result.confirmed) confirmed = false");
        expect(hook).toContain("return { confirmed };");
        expect(hook).toContain("uploadImage(beauty, undefined, expectedScope)");
    });
});

describe("编辑模式迁移到导演工具菜单", () => {
    test("所有模式入口保留可见名称、快捷提示并正确调用模式切换", () => {
        const modeMenu = slice(dock, 'key: "director-mode"', 'key: "workspace-view"');
        expect(modeMenu).toContain("DIRECTOR_MODES.map");
        expect(modeMenu).toContain("title: item.hint");
        expect(modeMenu).toContain("onModeChange(item.mode)");
        expect(modeMenu).toContain("releaseMenuFocus(domEvent.detail)");
    });

    test("菜单保持当前模式与工作区的选中态", () => {
        expect(dock).toContain("`director-mode-${mode}`");
        expect(dock).toContain("`workspace-${workspaceView}`");
    });

    test("模式样式继续使用主题感知语义 token，不新增硬编码颜色", () => {
        const block = slice(styles, "/* 一级模式切换。", ".director-actor-colors {");
        expect(block).toContain("var(--control-selected-bg)");
        expect(block).toContain("var(--control-focus-ring)");
        expect(block).not.toMatch(/rgba?\(/);
        expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    });
});

describe("LibTV 导演台紧凑顶栏入口迁移", () => {
    test("顶栏不再占用独立编辑模式或场景/预演切换条", () => {
        expect(workbench).not.toContain('<nav className="director-mode-switch" aria-label="导演台模式">');
        expect(workbench).not.toContain('aria-label="导演台工作区视图"');
    });

    test("底部更多工具菜单保留模式、工作区、历史与工作台功能；对象添加统一从场景面板进入", () => {
        expect(dock).toContain('label: "导演台模式"');
        expect(dock).toContain('key: "director-navigation", label: "导演台导航"');
        expect(dock).toContain("DIRECTOR_MODES.map");
        expect(dock).toContain('label: "工作区视图"');
        expect(dock).toContain('label: "场景调度"');
        expect(dock).toContain('label: "成片预演"');
        expect(dock).toContain("onModeChange(item.mode)");
        expect(dock).toContain('onWorkspaceViewChange("scene")');
        expect(dock).toContain('onWorkspaceViewChange("preview")');
        expect(dock).toContain('key: "export-clay"');
        expect(dock).toContain('key: "apply-to-canvas"');
        expect(dock).not.toContain('key: "add-actor"');
        expect(dock).not.toContain('key: "add-box"');
        expect(dock).not.toContain('aria-label="导演台导航" aria-haspopup="menu"');
        expect(workbench).toContain('AddMenuButton label="添加场景对象" items={addObjectMenuItems}');
    });

});
