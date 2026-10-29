import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(import.meta.dir, "../src/components/canvas/director/canvas-director-workbench.tsx"), "utf8");
const row = source.slice(source.indexOf("function SceneRow("), source.indexOf("function AddMenuButton("));

describe("导演台场景行右键操作", () => {
    test("场景对象右键提供已有的隐藏、锁定和删除功能，行内不再常驻删除按钮", () => {
        expect(row).toContain('trigger={["contextMenu"]}');
        expect(row).toContain("style: { minWidth: 144 }");
        expect(row).toContain('label: "显示/隐藏"');
        expect(row).toContain('label: "锁定/解锁"');
        expect(row).toContain('label: "删除"');
        expect(row).toContain("onDelete && !sceneActions");
    });

    test("明确选择右键删除仍调用原删除回调，锁定行菜单保持可见", () => {
        expect(row).toContain("onClick: onDelete");
        expect(row).not.toContain("disabled: locked");
    });

    test("单行右键保留禁用的打组入口，多选后启用打组，分组行提供解组", () => {
        expect(row).toContain('label: "打组"');
        expect(row).toContain("disabled: true");
        expect(row).toContain('label: "解组"');
        expect(row).toContain('label: "创建副本"');
    });
});
