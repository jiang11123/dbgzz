// 编辑器插件执行期权限校验，默认拒绝未知插件和缺失权限。
// v2 插件贡献 editorSlots 或代发 timeline 命令时，manifest.permissions 必须覆盖对应能力域；
// v1 插件不贡献 editorSlots，因此不经过这条插槽权限路径。本模块只做纯判定，
// 接入点分别位于插槽渲染（SlotStack）和宿主命令代发通道。

import { getRegisteredPlugin } from "@/lib/plugins/plugin-registry";
import type { EditorPluginPermission, EditorSlotKind } from "@/lib/plugins/plugin-types";

/** 每个编辑器插槽所需的最小权限域；新增插槽必须补表，否则会因找不到权限而拒绝渲染。 */
export const EDITOR_SLOT_REQUIRED_PERMISSION: Record<EditorSlotKind, EditorPluginPermission> = {
    "timeline-panel": "timeline.command",
    "preview-renderer": "timeline.read",
    inspector: "timeline.command",
    "asset-ingest": "timeline.command",
    "subtitle-tool": "timeline.command",
    "transcription-provider": "timeline.command",
    "export-renderer": "export.run",
    "ai-assistant": "timeline.read",
};

export type EditorSlotPermissionVerdict =
    | { allowed: true }
    | { allowed: false; reason: "plugin-not-registered" | "missing-permission"; missing: EditorPluginPermission | null };

/** fail-closed 权限判定：权限集缺失或未包含 required 一律拒绝。 */
export function checkEditorPermission(permissions: ReadonlySet<string> | null, required: EditorPluginPermission): boolean {
    return permissions !== null && permissions.has(required);
}

export function requiredPermissionForEditorSlot(slot: EditorSlotKind): EditorPluginPermission {
    return EDITOR_SLOT_REQUIRED_PERMISSION[slot];
}

/** 查询插件的权限集（未注册返回 null）。 */
export function pluginPermissions(pluginId: string): ReadonlySet<string> | null {
    const registered = getRegisteredPlugin(pluginId);
    if (!registered) return null;
    return new Set(registered.manifest.permissions ?? []);
}

/** 判定某插件是否被允许渲染某编辑器插槽（fail-closed；v2 注册即被检，缺失权限拒渲染）。 */
export function pluginMayRenderEditorSlot(pluginId: string, slot: EditorSlotKind): EditorSlotPermissionVerdict {
    const permissions = pluginPermissions(pluginId);
    if (permissions === null) {
        return { allowed: false, reason: "plugin-not-registered", missing: null };
    }
    const required = EDITOR_SLOT_REQUIRED_PERMISSION[slot];
    if (!permissions.has(required)) {
        return { allowed: false, reason: "missing-permission", missing: required };
    }
    return { allowed: true };
}

/** 宿主命令代发通道的权限断言：未注册插件或未声明目标权限时抛错，调用方必须阻止命令执行。 */
export function assertEditorPermission(pluginId: string, permission: EditorPluginPermission): void {
    const permissions = pluginPermissions(pluginId);
    if (permissions === null) {
        throw new Error(`插件 ${pluginId} 未注册，无法代发 ${permission} 命令`);
    }
    if (!permissions.has(permission)) {
        throw new Error(`插件 ${pluginId} 缺少 ${permission} 权限，命令已被拒绝`);
    }
}
