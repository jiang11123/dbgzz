import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { CanvasDirectorNodePanel } from "@/components/canvas/director/canvas-director-node-panel";
import { CanvasNode } from "@/components/canvas/canvas-node";
import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import { createDirectorScene } from "@/lib/canvas/director/director-scene";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const scene = createDirectorScene("镜头 1");
const node: CanvasNodeData = {
    id: "director-1",
    type: CanvasNodeType.Director,
    title: "导演台",
    position: { x: 0, y: 0 },
    width: 560,
    height: 560,
    metadata: { workflowKind: "shot", directorSceneId: scene.id, directorShotId: scene.shots[0].id },
};

function render(readNodeContent: (id: string | undefined) => string | undefined = () => undefined) {
    return renderToStaticMarkup(<CanvasDirectorNodePanel node={node} scene={scene} readNodeContent={readNodeContent} onOpen={() => {}} />);
}

describe("导演台画布节点", () => {
    test("空导演台只显示场景预览和明确的打开按钮，不显示节点内生成提示框", () => {
        const markup = render();
        expect(markup).not.toContain("导演台</div>");
        expect(markup).toContain("打开导演台");
        expect(markup).not.toContain('aria-label="场景描述"');
        expect(markup).not.toContain("描述想要搭建的场景");
        expect(markup).not.toContain("在导演台中使用描述");
        expect(markup).not.toContain("对象</span>");
    });

    test("已有封面裁剪铺满节点，并通过独立按钮打开导演台", () => {
        const withPreview = { ...node, metadata: { ...node.metadata, directorPreviewNodeId: "image-1" } };
        const markup = renderToStaticMarkup(<CanvasDirectorNodePanel node={withPreview} scene={scene} readNodeContent={() => "https://example.test/cover.png"} onOpen={() => {}} />);
        expect(markup).toContain('src="https://example.test/cover.png"');
        expect(markup).toContain("object-cover");
        expect(markup).toContain("打开导演台");
        expect(markup).toContain('data-director-open="preview"');
        expect(markup).toContain('aria-label="打开导演台"');
        expect(markup).toContain('class="absolute left-1/2 top-1/2');
        expect(markup).toContain("-translate-y-1/2");
        expect(markup).toContain("px-6 py-4 text-base font-semibold");
        expect(markup).toContain("size-8");
        expect(markup).not.toContain("scale(var(--canvas-live-inverse-scale");
        expect(markup).not.toContain("aspect-square");
    });

    test("默认导演台画布尺寸适度放大", () => {
        expect(NODE_DEFAULT_SIZE[CanvasNodeType.Director]).toMatchObject({ width: 640, height: 640 });
    });

    test("空态打开入口可用键盘聚焦且提供按钮语义", () => {
        const markup = render();
        expect(markup).toContain('data-director-open="empty"');
        expect(markup).toContain("focus-visible:ring-2");
        expect(markup).toContain('aria-label="打开导演台"');
    });

    test("持久封面优先于旧预览且仍保留旧项目回落", () => {
        const withCover = { ...node, metadata: { ...node.metadata, directorCoverUrl: "https://assets.example/cover.png", directorPreviewNodeId: "legacy" } };
        const markup = renderToStaticMarkup(<CanvasDirectorNodePanel node={withCover} scene={scene} readNodeContent={() => "https://assets.example/legacy.png"} onOpen={() => {}} />);
        expect(markup).toContain('src="https://assets.example/cover.png"');
        expect(markup).not.toContain('src="https://assets.example/legacy.png"');
    });

    test("导演节点不被通用视频节点外壳包成第二张灰色卡片", () => {
        const markup = renderToStaticMarkup(<CanvasNode
            data={{ ...node, width: 720 }} scale={1} isSelected={false} isRelated={false} isFocusRelated={false}
            isConnectionTarget={false} showImageInfo={false}
            onMouseDown={() => {}} onHoverStart={() => {}} onHoverEnd={() => {}}
            onConnectStart={() => {}} onResize={() => {}} onContentChange={() => {}}
            onContextMenu={() => {}} renderNodeContent={() => <CanvasDirectorNodePanel node={node} scene={scene} readNodeContent={() => undefined} onOpen={() => {}} />}
        />);
        const shell = markup.match(/class="canvas-node-shell[^\"]*"[^>]*style="([^"]*)"/)?.[1];
        expect(shell).toBeDefined();
        expect(shell).toContain("background:transparent");
        expect(shell).toContain("border:0");
        expect(shell).toContain("box-shadow:none");
        const header = markup.match(/class="canvas-node-external-header[^\"]*"[^>]*style="([^"]*)"/)?.[1];
        expect(header).toContain("--canvas-node-width:720px;");
        expect(header).not.toContain("left:");
        expect(markup).toContain('data-node-header-icon="director"');
    });
});
