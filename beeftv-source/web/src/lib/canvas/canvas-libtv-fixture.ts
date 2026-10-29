import { createCanvasNode } from "@/lib/canvas/canvas-project-domain";
import { createDefaultMediaConversionState } from "@/lib/media-conversion/contracts";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { createDefaultSubtitleStyle } from "@/types/timeline";
import { libtvOriginalThumbnailUrls } from "@/lib/canvas/libtv-original-media";
import { libtvOriginalMediaLayout } from "@/lib/canvas/libtv-original-layout";
import { libtvOriginalAudioNodes } from "@/lib/canvas/libtv-original-special-nodes";
import { libtvCurrentVisibleNodes } from "@/lib/canvas/libtv-current-node-layout";
import { libtvCurrentVisibleMedia } from "@/lib/canvas/libtv-current-media";

// 用于本地视觉回归的 LibTV 风格分镜项目夹具：真实图片节点、真实 parentId
// 和两组有语义的背板，方便每轮和原版 dense project 做截图对比。
export function createLibTvStoryboardFixture(): CanvasNodeData[] {
    const nodes: CanvasNodeData[] = [];
    const groups = [
        { id: "01", title: "分镜组01｜少年归来·骑行驶来→停车眺望→取随身听", x: -650, y: -280, colors: ["#223b5d", "#486b8b", "#c28b56"] },
        { id: "02", title: "分镜组02｜逃离此地·戴耳机→走入稻田→感受风", x: 450, y: -280, colors: ["#415443", "#81966c", "#d2a86a"] },
    ];

    for (const group of groups) {
        const frame = createCanvasNode(CanvasNodeType.Frame, { x: group.x + 470, y: group.y + 280 }, {
            workflowKind: "storyboard",
            workflowTitle: `分镜组 ${group.id}`,
            frame: { collapsed: false, expandedWidth: 940, expandedHeight: 560 },
        });
        frame.title = group.title;
        frame.position = { x: group.x, y: group.y };
        frame.width = 940;
        frame.height = 560;
        frame.metadata = { ...frame.metadata, fixture: "libtv-storyboard" };
        nodes.push(frame);

        ["骑行驶来", "停车眺望", "取随身听"].forEach((shot, index) => {
            const image = createCanvasNode(CanvasNodeType.Image, { x: group.x + 190 + index * 285, y: group.y + 295 }, {
                content: fixtureImage(group.colors[index], shot),
                status: "success",
                workflowKind: "shot",
                workflowTitle: `${group.id}-S0${index + 1} ${shot}`,
                shotIndex: index + 1,
            });
            image.parentId = frame.id;
            image.title = `S0${index + 1}`;
            image.position = { x: group.x + 34 + index * 295, y: group.y + 112 };
            image.width = 270;
            image.height = 152;
            image.metadata = { ...image.metadata, fixture: "libtv-storyboard" };
            nodes.push(image);
        });
    }

    const looseText = createCanvasNode(CanvasNodeType.Text, { x: 550, y: 220 }, {
        content: "岩井俊二美学\n冷色、自然光、青春与消逝。",
        workflowKind: "styleboard",
        workflowTitle: "项目画风",
    });
    looseText.title = "岩井俊二美学";
    looseText.metadata = { ...looseText.metadata, fixture: "libtv-storyboard" };
    nodes.push(looseText);

    return nodes;
}

/**
 * Read-only public-canvas fixture matching the dense LibTV browse view.  The
 * real project is intentionally large; this deterministic subset preserves
 * the visual invariants that matter for the canvas shell: seven named groups,
 * two-column framing, 10% overview scale, thumbnail rhythm, and parent/child
 * relationships.  It is opt-in and never enters a normal project.
 */
export function createLibTvReadonlyDenseFixture(): CanvasNodeData[] {
    const viewport = { x: 189.2, y: -179.4, k: 0.1 };
    return libtvCurrentVisibleNodes.map((item, index) => {
        const media = libtvCurrentVisibleMedia.reduce<typeof libtvCurrentVisibleMedia[number] | null>((best, candidate) => {
            const distance = Math.hypot(candidate.x - item.x, candidate.y - item.y);
            return !best || distance < Math.hypot(best.x - item.x, best.y - item.y) ? candidate : best;
        }, null);
        const nodeType = item.type === "video" ? CanvasNodeType.Video : item.type === "audio" ? CanvasNodeType.Audio : CanvasNodeType.Image;
        const node = createCanvasNode(nodeType, { x: (item.x - viewport.x) / viewport.k, y: (item.y - viewport.y) / viewport.k }, {
            content: nodeType === CanvasNodeType.Video ? (media?.src || "").split("?", 1)[0] : nodeType === CanvasNodeType.Image ? media?.src || fixtureImage("#233c59", `BLUE NIGHT ${index + 1}`) : "",
            ...(nodeType === CanvasNodeType.Video ? { previewContent: media?.src || "" } : {}),
            status: "success",
            workflowKind: "shot",
            workflowTitle: item.text || `BLUE NIGHT 节点 ${index + 1}`,
        });
        node.id = `libtv-current-${item.type}-${index + 1}`;
        node.title = item.text || `BLUE NIGHT 节点 ${index + 1}`;
        node.width = item.width / viewport.k;
        node.height = item.height / viewport.k;
        node.position = { x: (item.x - viewport.x) / viewport.k, y: (item.y - viewport.y) / viewport.k };
        node.metadata = {
            ...node.metadata,
            fixture: "libtv-readonly-dense",
            // The real LibTV viewer marks imported media as externally owned;
            // that prevents the normal image-load callback from replacing the
            // captured 62×35 overview geometry with the editor's 420px minimum.
            importSource: { provider: "libtv", projectUuid: "readonly-blue-night", nodeKey: node.id, batchId: "readonly" },
        };
        return node;
    });
}

function createLibTvReadonlyDenseGroupedFixture(): CanvasNodeData[] {
    const nodes: CanvasNodeData[] = [];
    const groups = [
        { id: "18", x: 0, y: -3800 },
        { id: "15", x: 0, y: 0 },
        { id: "17", x: 8000, y: 0 },
        { id: "14", x: 0, y: 3800 },
        { id: "29", x: 8000, y: 3800 },
        { id: "13", x: 0, y: 7600 },
        { id: "16", x: 8000, y: 7600 },
    ];
    const frames = groups.map((group) => {
        const frame = createCanvasNode(CanvasNodeType.Frame, { x: group.x + 3300, y: group.y + 1730 }, {
            workflowTitle: `Group ${group.id}`,
            frame: { collapsed: false, expandedWidth: 6600, expandedHeight: 3460 },
        });
        frame.id = `libtv-dense-frame-${group.id}`;
        frame.title = `Group ${group.id}`;
        frame.position = { x: group.x, y: group.y };
        frame.width = 6600;
        frame.height = 3460;
        frame.metadata = { ...frame.metadata, fixture: "libtv-readonly-dense" };
        nodes.push(frame);
        return { ...group, frame };
    });
    libtvOriginalMediaLayout.forEach((media, index) => {
        const worldX = (media.x - 115) * 10;
        const worldY = (media.y - 140) * 10;
        const owner = frames.find((group) => worldX >= group.x && worldX < group.x + 6600 && worldY >= group.y && worldY < group.y + 3460) || frames[0];
        const isCapturedVideo = media.src.includes("/video/") || media.src.includes("result.mp4");
        const image = createCanvasNode(isCapturedVideo ? CanvasNodeType.Video : CanvasNodeType.Image, { x: worldX, y: worldY }, {
            content: isCapturedVideo ? media.src.split("?", 1)[0] : media.src,
            ...(isCapturedVideo ? { previewContent: media.src } : {}),
            status: "success",
            workflowKind: "shot",
            workflowTitle: `${owner.id}-${String(index + 1).padStart(3, "0")}`,
            shotIndex: index + 1,
        });
        image.id = `libtv-dense-media-${index + 1}`;
        image.parentId = owner.frame.id;
        image.title = `${owner.id} 素材 ${index + 1}`;
        image.position = { x: worldX, y: worldY };
        image.width = media.width * 10;
        image.height = media.height * 10;
        image.metadata = { ...image.metadata, fixture: "libtv-readonly-dense" };
        nodes.push(image);
    });
    libtvOriginalAudioNodes.forEach((audio, index) => {
        const worldX = (audio.x - 115) * 10;
        const worldY = (audio.y - 140) * 10;
        const owner = frames.find((group) => worldX >= group.x && worldX < group.x + 6600 && worldY >= group.y && worldY < group.y + 3460) || frames[0];
        const node = createCanvasNode(CanvasNodeType.Audio, { x: worldX, y: worldY }, {
            content: "",
            status: "success",
            workflowKind: "shot",
            workflowTitle: audio.text || `音频 ${index + 1}`,
        });
        node.id = `libtv-dense-audio-${index + 1}`;
        node.parentId = owner.frame.id;
        node.title = audio.text || `音频 ${index + 1}`;
        node.position = { x: worldX, y: worldY };
        node.width = audio.width * 10;
        node.height = audio.height * 10;
        node.metadata = { ...node.metadata, fixture: "libtv-readonly-dense" };
        nodes.push(node);
    });
    return nodes;
}

function createLibTvReadonlyDenseGridFixture(): CanvasNodeData[] {
    const nodes: CanvasNodeData[] = [];
    const groups = [
        { id: "18", x: 0, y: -3800, tone: "#1e3447" },
        { id: "15", x: 0, y: 0, tone: "#294b62" },
        { id: "17", x: 8000, y: 0, tone: "#354d56" },
        { id: "14", x: 0, y: 3800, tone: "#6a5d4b" },
        { id: "29", x: 8000, y: 3800, tone: "#293e50" },
        { id: "13", x: 0, y: 7600, tone: "#30455b" },
        { id: "16", x: 8000, y: 7600, tone: "#514e56" },
    ];
    const shots = [
        ["雨夜车站", "#243d52"],
        ["人物定妆", "#5a6872"],
        ["深夜街景", "#1b2d3f"],
        ["道具特写", "#8a6d4b"],
        ["远景镜头", "#38586b"],
        ["情绪近景", "#263f52"],
        ["地下通道", "#243344"],
        ["角色群像", "#51606c"],
        ["雾中建筑", "#31495b"],
        ["手部特写", "#806545"],
        ["车站远景", "#2b5266"],
        ["灯光测试", "#435466"],
        ["夜行镜头", "#1c2a38"],
        ["道具设计", "#6c5a49"],
        ["最终画面", "#344d5f"],
        ["夜景素材", "#263b4b"],
        ["角色侧脸", "#53636b"],
        ["场景概念", "#3e5663"],
        ["雾气测试", "#617069"],
        ["服装参考", "#6c594c"],
        ["镜头草图", "#30495b"],
    ] as const;
    const columns = 7;
    const rows = 3;
    const frameWidth = 6600;
    const frameHeight = 3460;
    for (const [groupIndex, group] of groups.entries()) {
        const frame = createCanvasNode(CanvasNodeType.Frame, { x: group.x + frameWidth / 2, y: group.y + frameHeight / 2 }, {
            workflowTitle: `Group ${group.id}`,
            frame: { collapsed: false, expandedWidth: frameWidth, expandedHeight: frameHeight },
        });
        frame.id = `libtv-dense-frame-${group.id}`;
        frame.title = `Group ${group.id}`;
        frame.position = { x: group.x, y: group.y };
        frame.width = frameWidth;
        frame.height = frameHeight;
        frame.metadata = { ...frame.metadata, fixture: "libtv-readonly-dense" };
        nodes.push(frame);
        shots.forEach(([label, color], index) => {
            const col = index % columns;
            const row = Math.floor(index / columns);
            const capturedThumbnail = libtvOriginalThumbnailUrls[groupIndex * shots.length + index];
            const image = createCanvasNode(CanvasNodeType.Image, { x: group.x + 280 + col * 940, y: group.y + 260 + row * 900 }, {
                // Use the captured public thumbnails when available. The
                // deterministic SVG remains a fallback for an unavailable
                // remote asset, so the fixture stays renderable offline.
                content: capturedThumbnail || fixtureImage(index % 2 ? color : group.tone, label),
                status: "success",
                workflowKind: "shot",
                workflowTitle: `${group.id}-${String(index + 1).padStart(2, "0")} ${label}`,
                shotIndex: index + 1,
            });
            image.id = `libtv-dense-${group.id}-${index + 1}`;
            image.parentId = frame.id;
            image.title = label;
            image.position = { x: group.x + 180 + col * 940, y: group.y + 120 + row * 900 };
            image.width = 620;
            // LibTV's overview renders media cards at roughly 35px tall when
            // the camera is at 10%; keep the world height aligned with that
            // observed read-only geometry.
            image.height = 350;
            image.metadata = { ...image.metadata, fixture: "libtv-readonly-dense" };
            nodes.push(image);
        });
    }
    return nodes;
}

// 用于验证“已有结果”态的视频节点：内容使用非空的本地 data URL 触发
// LibTV 菜单/预览状态，缩略图仍使用确定性的本地 SVG，避免视觉回归依赖外网。
export function createLibTvVideoFixture(contentOverride?: string): CanvasNodeData[] {
    const video = createCanvasNode(CanvasNodeType.Video, { x: 80, y: 40 }, {
        content: "data:video/mp4;base64,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",
        previewContent: fixtureImage("#294c68", "风吹稻田"),
        status: "success",
        prompt: "雨夜车站，冷色自然光与湿润路面反光",
        mimeType: "video/mp4",
        durationMs: 5000,
        seconds: "5s",
        workflowKind: "shot",
        workflowTitle: "视频结果｜风吹稻田",
    });
    video.title = "视频结果｜风吹稻田";
    video.width = 720;
    video.height = 405;
    video.metadata = { ...video.metadata, fixture: "libtv-video" };
    if (contentOverride) video.metadata = { ...video.metadata, content: contentOverride, mimeType: "video/mp4", durationMs: 6080 };
    return [video];
}

/** Video plus a connected conversion node for the local first-frame conversion audit. */
export function createLibTvVideoConversionFixture(contentOverride?: string): { nodes: CanvasNodeData[]; connection: { id: string; fromNodeId: string; toNodeId: string } } {
    const [video] = createLibTvVideoFixture(contentOverride);
    video.id = "libtv-video-conversion-source";
    const conversion = createCanvasNode(CanvasNodeType.MediaConversion, { x: 860, y: 40 }, {
        mediaConversion: createDefaultMediaConversionState(),
    });
    conversion.id = "libtv-video-conversion-target";
    conversion.title = "视频首帧转换";
    conversion.metadata = { ...conversion.metadata, fixture: "libtv-video-conversion" };
    return { nodes: [video, conversion], connection: { id: "libtv-video-conversion-edge", fromNodeId: video.id, toNodeId: conversion.id } };
}

/** Completed video fixture with subtitle entries for the timeline↔node writeback audit. */
export function createLibTvVideoSubtitleFixture(contentOverride?: string): CanvasNodeData[] {
    const [video] = createLibTvVideoFixture(contentOverride);
    video.id = "libtv-video-subtitle-fixture";
    video.title = "视频结果｜字幕样片";
    video.metadata = {
        ...video.metadata,
        fixture: "libtv-video-subtitle",
        subtitleEntries: [
            { index: 0, startMs: 0, endMs: 2200, text: "风从稻田吹来" },
            { index: 1, startMs: 2400, endMs: 4800, text: "镜头保持冷色自然光" },
        ],
        subtitleStyle: { ...createDefaultSubtitleStyle(), fontSize: 24, color: "#ffffff", position: "bottom", maxCharsPerEntry: 32, highlightRadius: 8 },
        subtitleUpdatedAt: new Date(0).toISOString(),
    };
    return [video];
}

/** Two completed video results used to exercise LibTV's merge-to-final-node flow. */
export function createLibTvVideoMergeFixture(contentOverride?: string): CanvasNodeData[] {
    const [first] = createLibTvVideoFixture(contentOverride);
    const second: CanvasNodeData = {
        ...first,
        id: "libtv-video-fixture-2",
        title: "视频结果｜车站远景",
        position: { x: first.position.x + first.width + 96, y: first.position.y },
        metadata: { ...first.metadata, fixture: "libtv-video-merge", prompt: "车站远景，冷色自然光" },
    };
    first.metadata = { ...first.metadata, fixture: "libtv-video-merge" };
    return [first, second];
}

export function createLibTvAudioFixture(): CanvasNodeData[] {
    const audio = createCanvasNode(CanvasNodeType.Audio, { x: 80, y: 40 }, {
        content: "data:audio/wav;base64,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",
        status: "success",
        prompt: "风吹稻田，轻柔环境声与自然呼吸感",
        mimeType: "audio/wav",
        durationMs: 100,
        audioVoice: "中文",
        audioFormat: "wav",
        audioSpeed: "1.0",
    });
    audio.title = "音频结果｜风吹稻田";
    audio.width = 320;
    audio.height = 320;
    audio.metadata = { ...audio.metadata, fixture: "libtv-audio" };
    return [audio];
}

export function createLibTvTextFixture(): CanvasNodeData[] {
    const text = createCanvasNode(CanvasNodeType.Text, { x: 80, y: 40 }, {
        content: "镜头基调：冷色自然光，保留青春感与空气中的风。",
        status: "success",
        prompt: "生成镜头基调：冷色自然光，保留青春感与空气中的风",
        workflowKind: "styleboard",
        workflowTitle: "文本结果｜镜头基调",
        fontSize: 24,
    });
    text.title = "文本结果｜镜头基调";
    text.width = 420;
    text.height = 240;
    text.metadata = { ...text.metadata, fixture: "libtv-text" };
    return [text];
}

/** Empty text node matching the default LibTV canvas creation state. */
export function createLibTvEmptyTextFixture(): CanvasNodeData[] {
    // Coordinates mirror the captured LibTV Agent-open reference at the
    // default 100% viewport, where the node sits just left of the docked
    // Agent panel rather than directly under the top bar.
    const text = createCanvasNode(CanvasNodeType.Text, { x: 172, y: 174 }, {
        status: "success",
        model: "GVLM 3.1",
        fontSize: 14,
    });
    text.id = "libtv-empty-text-fixture";
    text.title = "文本节点1";
    text.width = 350;
    text.height = 350;
    const { status: _status, ...emptyTextMetadata } = text.metadata || {};
    text.metadata = { ...emptyTextMetadata, fixture: "libtv-text-empty" };
    return [text];
}

// 仅用于本地任务状态视觉回归：模拟真实生成任务已提交、仍在处理中。
// 不会进入默认项目，只有 ?fixture=libtv-generating 时才注入。
export function createLibTvGeneratingFixture(): CanvasNodeData[] {
    const image = createCanvasNode(CanvasNodeType.Image, { x: 80, y: 40 }, {
        status: "loading",
        workflowKind: "shot",
        workflowTitle: "生成中｜雨夜车站",
    });
    image.title = "生成中｜雨夜车站";
    image.width = 480;
    image.height = 270;
    image.metadata = {
        ...image.metadata,
        fixture: "libtv-generating",
        // Keep a deterministic task identity so the loading card exposes the
        // same detail/cancel affordances as a real in-flight LibTV task.
        taskId: "libtv-fixture-task-42",
        taskCreatedAt: new Date(0).toISOString(),
        taskStatus: "running",
        taskProgress: 42,
        taskStage: "正在生成画面",
        taskProvider: "Lib Image 2.5 Pro",
    };
    return [image];
}

function fixtureImage(color: string, label: string) {
    const encoded = encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${color}"/><stop offset="1" stop-color="#101318"/></linearGradient></defs><rect width="640" height="360" fill="url(#g)"/><circle cx="490" cy="90" r="62" fill="#f4d7a1" opacity=".26"/><path d="M0 300 Q180 210 330 300 T640 270 V360 H0Z" fill="#0b1118" opacity=".56"/><text x="28" y="320" fill="#fff" opacity=".9" font-family="Arial,sans-serif" font-size="24">${label}</text></svg>`);
    return `data:image/svg+xml,${encoded}`;
}
