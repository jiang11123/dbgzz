import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { DirectorScene } from "@/types/director";

/** Move legacy prose and clear its old fields in the same project update. */
export function migrateDirectorCanvas(nodes: CanvasNodeData[], scenes: DirectorScene[]) {
    let directorScenes = scenes;
    const migrated = nodes.map((node) => {
        const scene = directorScenes.find((entry) => entry.id === node.metadata?.directorSceneId);
        const shot = scene?.shots.find((entry) => entry.id === node.metadata?.directorShotId) ?? (!node.metadata?.directorShotId ? scene?.shots.find((entry) => entry.id === scene.activeShotId) ?? scene?.shots[0] : undefined);
        const legacy = [node.metadata?.composerContent, node.metadata?.prompt].filter((value): value is string => typeof value === "string" && Boolean(value.trim()));
        if (scene && shot && legacy.length) {
            const values = [shot.prompt, ...legacy].filter((value) => Boolean(value?.trim()));
            const seen = new Set<string>();
            const prompt = values.filter((value) => {
                const key = value.trim();
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            }).join("\n\n");
            if (prompt !== shot.prompt) directorScenes = directorScenes.map((entry) => entry.id === scene.id ? { ...entry, shots: entry.shots.map((item) => item.id === shot.id ? { ...item, prompt } : item) } : entry);
        }
        return normalizeDirectorCanvasNode(node, Boolean(shot));
    });
    return { nodes: migrated, directorScenes };
}

/** Reclassifies legacy director cards that were persisted as video generators. */
export function normalizeDirectorCanvasNode(node: CanvasNodeData, proseTransferred = false): CanvasNodeData {
    if (!node.metadata?.directorSceneId) return node;

    const needsCleanup = node.metadata.generationMode !== undefined
        || node.metadata.videoEditOperation !== undefined
        || (proseTransferred && (node.metadata.composerContent !== undefined || node.metadata.prompt !== undefined));
    const hasLegacyDefaultSize = node.type === CanvasNodeType.Director && node.width === 560 && node.height === 560;
    if (node.type === CanvasNodeType.Director && !needsCleanup && !hasLegacyDefaultSize) return node;

    const metadata = { ...node.metadata };
    delete metadata.generationMode;
    delete metadata.videoEditOperation;
    if (proseTransferred) {
        delete metadata.composerContent;
        delete metadata.prompt;
    }

    return {
        ...node,
        type: CanvasNodeType.Director,
        title: node.type === CanvasNodeType.Director ? node.title : "导演台",
        width: hasLegacyDefaultSize ? 640 : node.width,
        height: hasLegacyDefaultSize ? 640 : node.height,
        metadata,
    };
}
