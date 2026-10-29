import { canonicalize } from "json-canonicalize";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

// These fields describe local viewing / synchronization, not an edit to the document.
export function canvasContentSnapshot(project: CanvasProject) {
    const { viewport: _viewport, updatedAt: _updatedAt, revision: _revision, remoteContentHash: _hash, ...content } = project;
    return { ...content, projectId: content.projectId || undefined };
}

export function sameCanvasContent(left: CanvasProject | undefined, right: CanvasProject | undefined) {
    if (left === right) return true;
    if (!left || !right) return false;
    const a = canvasContentSnapshot(left) as Record<string, unknown>;
    const b = canvasContentSnapshot(right) as Record<string, unknown>;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].every((key) => a[key] === b[key] || canonicalize(a[key]) === canonicalize(b[key]));
}

export async function canvasContentHash(project: CanvasProject) {
    const serialized = canonicalize(canvasContentSnapshot(project));
    // LAN HTTP deployments may lack Web Crypto. Keep an exact baseline there;
    // a lossy checksum could incorrectly discard an unsaved draft during login.
    if (!globalThis.crypto?.subtle) return `json:${serialized}`;
    const bytes = new TextEncoder().encode(serialized);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

/**
 * 只比较画布文档内容，忽略本机查看偏好。
 *
 * 复用 `canvasContentSnapshot` 的同一套「非文档字段」规则（它已经排除视口、时间戳、
 * revision 与远端哈希），而不是另立一份字段白名单：白名单会静默漏掉没列进去的文档
 * 字段（例如 folderId、projectId、canvasTitle），让用户未确认的编辑被当成「本地干净」。
 *
 * 两处刻意容忍的不对称，都不代表用户编辑过文档：
 * 1. 画布外观偏好（appearance/backgroundMode/showImageInfo）：服务端由客户端决定是否写入，
 *    外部写入产生的画布常常没有它们；套用外部 revision 时本机外观也不会被覆盖
 *    （见 canvas-external-revision.ts）。
 * 2. 一侧缺失、另一侧为空值：应用自己会给 nodes/connections/chatSessions/activeChatId
 *    这类字段补默认空值。只有「缺失 vs 非空值」才算差异，因此 folderId 从无到有、
 *    projectId/canvasTitle 被设置、节点被删除都会如实识别。
 */
const CANVAS_VIEW_PREFERENCE_KEYS = new Set(["appearance", "backgroundMode", "showImageInfo"]);

/**
 * 服务端拥有、应用从不编辑的元数据。
 *
 * `createdAt` 由服务端在首次写入时确定，`updateProject` 也不会改动它；外部写入产生的
 * 画布文档可能没有这个字段，缺失不代表用户编辑过内容。
 */
const CANVAS_SERVER_OWNED_KEYS = new Set(["createdAt"]);

function isEmptyDefaultValue(value: unknown) {
    if (value === undefined || value === null) return true;
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length === 0;
    return value === "";
}

export function sameCanvasDocument(left: CanvasProject | undefined, right: CanvasProject | undefined) {
    if (left === right) return true;
    if (!left || !right) return false;
    const a = canvasContentSnapshot(left) as Record<string, unknown>;
    const b = canvasContentSnapshot(right) as Record<string, unknown>;
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (CANVAS_VIEW_PREFERENCE_KEYS.has(key) || CANVAS_SERVER_OWNED_KEYS.has(key)) continue;
        const presentInA = Object.hasOwn(a, key) && a[key] !== undefined;
        const presentInB = Object.hasOwn(b, key) && b[key] !== undefined;
        if (!presentInA || !presentInB) {
            const present = presentInA ? a[key] : b[key];
            if (isEmptyDefaultValue(present)) continue;
            return false;
        }
        if (a[key] !== b[key] && canonicalize(a[key]) !== canonicalize(b[key])) return false;
    }
    return true;
}
