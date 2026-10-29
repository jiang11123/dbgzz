import type { DirectorCamera, DirectorGroup, DirectorLight, DirectorObject, DirectorScene } from "@/types/director";

export type DirectorSceneSearchItem =
    | { kind: "camera"; id: string; name: string; camera: DirectorCamera }
    | { kind: "group"; id: string; name: string; group: DirectorGroup }
    | { kind: "object"; id: string; name: string; object: DirectorObject }
    | { kind: "light"; id: string; name: string; light: DirectorLight };

/** Flat scene hierarchy shown by the director sidebar; filtering never changes the scene. */
export function searchDirectorSceneItems(scene: DirectorScene, query: string): DirectorSceneSearchItem[] {
    const normalized = query.trim().toLocaleLowerCase();
    const matches = (name: string) => !normalized || name.toLocaleLowerCase().includes(normalized);
    const items: DirectorSceneSearchItem[] = scene.cameras.filter((camera) => matches(camera.name)).map((camera) => ({ kind: "camera", id: camera.id, name: camera.name, camera }));
    const emitted = new Set<string>();
    for (const object of scene.objects) {
        if (!object.groupId) {
            if (matches(object.name)) items.push({ kind: "object", id: object.id, name: object.name, object });
            continue;
        }
        const group = scene.groups?.find((entry) => entry.id === object.groupId);
        if (!group) {
            if (matches(object.name)) items.push({ kind: "object", id: object.id, name: object.name, object });
            continue;
        }
        if (emitted.has(object.groupId)) continue;
        emitted.add(object.groupId);
        const members = scene.objects.filter((entry) => entry.groupId === group.id);
        if (!matches(group.name) && !members.some((member) => matches(member.name))) continue;
        items.push({ kind: "group", id: group.id, name: group.name, group });
        if (!group.collapsed) for (const member of members) if (matches(group.name) || matches(member.name)) items.push({ kind: "object", id: member.id, name: member.name, object: member });
    }
    items.push(...scene.lights.filter((light) => matches(light.name)).map((light) => ({ kind: "light" as const, id: light.id, name: light.name, light })));
    return items;
}

/** 场景行的 Shift 连续多选。筛选使锚点不在当前列表时退化为单选。 */
export function resolveDirectorSceneSelection(order: string[], current: string[], anchor: string | null, target: string, shift: boolean): string[] {
    const targetIndex = order.indexOf(target);
    if (targetIndex < 0) return current.filter((id) => order.includes(id));
    const anchorIndex = anchor ? order.indexOf(anchor) : -1;
    if (!shift || anchorIndex < 0) return [target];
    return order.slice(Math.min(anchorIndex, targetIndex), Math.max(anchorIndex, targetIndex) + 1);
}
