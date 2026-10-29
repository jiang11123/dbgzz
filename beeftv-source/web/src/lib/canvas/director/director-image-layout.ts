export type DirectorImageLayoutElement = { name: string; type: "person" | "object"; x: number; depth: number };

/** Parse untrusted model output into bounded canvas coordinates; image text is never treated as instructions. */
export function parseDirectorImageLayout(raw: string): DirectorImageLayoutElement[] {
    const candidate = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    let value: unknown;
    try { value = JSON.parse(candidate); } catch { throw new Error("识图结果格式无效"); }
    if (!value || typeof value !== "object" || !Array.isArray((value as { elements?: unknown }).elements)) throw new Error("识图结果格式无效");
    const result: DirectorImageLayoutElement[] = [];
    for (const item of (value as { elements: unknown[] }).elements.slice(0, 16)) {
        if (!item || typeof item !== "object") continue;
        const row = item as Record<string, unknown>;
        if (typeof row.name !== "string" || !row.name.trim() || (row.type !== "person" && row.type !== "object") || typeof row.x !== "number" || !Number.isFinite(row.x) || typeof row.depth !== "number" || !Number.isFinite(row.depth)) continue;
        result.push({ name: row.name.trim().slice(0, 64), type: row.type, x: Math.max(0, Math.min(1, row.x)), depth: Math.max(0, Math.min(1, row.depth)) });
    }
    if (!result.length) throw new Error("未识别到可用的人物或物体");
    return result;
}
