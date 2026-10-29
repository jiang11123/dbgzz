import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { creationConflictPreview } from "../src/pages/create/creation-conflict";

test("conflict preview uses last user text without inventing a title", () => {
    expect(creationConflictPreview({ title: "  ", messages: [] })).toEqual({
        title: "未命名对话",
        messageCount: 0,
        excerpt: "还没有文字",
    });
    expect(creationConflictPreview({
        title: "镜头",
        messages: [
            { role: "user", content: "第一句" },
            { role: "assistant", content: "回复" },
            { role: "user", content: "  最近一句还很长，需要截成预览 " },
        ],
    })).toEqual({
        title: "镜头",
        messageCount: 3,
        excerpt: "最近一句还很长，需要截成预览",
    });
});

test("conflict UI copy is concrete Chinese actions without implementation jargon", () => {
    const conflictUi = readFileSync(resolve(import.meta.dir, "../src/pages/create/creation-conflict.tsx"), "utf8");
    const createPage = readFileSync(resolve(import.meta.dir, "../src/pages/create/index.tsx"), "utf8");
    expect(conflictUi).toContain("这份对话和已保存的版本不一样。先看两边，再决定用哪一份。");
    expect(conflictUi).toContain("查看两边");
    expect(conflictUi).toContain("用已保存的版本");
    expect(conflictUi).toContain("用这份草稿替换已保存的版本");
    expect(conflictUi).toContain("先不处理");
    expect(conflictUi).toContain("已改为已保存的版本。刚才的草稿还在，可以再换回来。");
    expect(conflictUi).toContain("恢复刚才的草稿");
    expect(conflictUi).toContain("有两个版本");
    expect(conflictUi).not.toContain("CAS");
    expect(conflictUi).not.toContain("IndexedDB");
    expect(conflictUi).not.toContain("远端");
    expect(conflictUi).not.toContain("conflictRemote");
    expect(createPage).toContain("CreationConflictBanner");
    expect(createPage).toContain("resolveConflictIds");
    expect(createPage).toContain("acceptSavedCreationConversation");
    expect(createPage).toContain("restoreParkedCreationConversation");
    expect(createPage).toContain("无法换成已保存的版本");
    expect(createPage).toContain("这份草稿没有保存成功，原来的版本还在");
});
