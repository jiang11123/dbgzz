import type { SrtEntry, SubtitleHighlight } from "@/types/timeline";
import { filterValidSubtitleHighlights } from "./subtitle-highlights";
interface SubtitleHighlightLLMResult {
    entryIndex: number;
    shouldHighlight: boolean;
    highlightText: string;
    start: number;
    end: number;
}

function isSubtitleHighlightLLMResult(value: unknown): value is SubtitleHighlightLLMResult {
    if (!value || typeof value !== "object") {
        return false;
    }

    const candidate = value as Record<string, unknown>;
    return Number.isFinite(candidate.entryIndex) && typeof candidate.shouldHighlight === "boolean" && typeof candidate.highlightText === "string" && Number.isFinite(candidate.start) && Number.isFinite(candidate.end);
}

export function parseSubtitleHighlightResponse(payload: unknown, entries: SrtEntry[]): SubtitleHighlight[] {
    if (!payload || typeof payload !== "object") {
        return [];
    }

    const rawHighlights = Array.isArray((payload as { highlights?: unknown[] }).highlights) ? (payload as { highlights: unknown[] }).highlights : [];
    const entryMap = new Map(entries.map((entry) => [entry.index, entry]));

    const highlights = rawHighlights.flatMap((item) => {
        if (!isSubtitleHighlightLLMResult(item) || !item.shouldHighlight) {
            return [];
        }

        const entry = entryMap.get(item.entryIndex);
        if (!entry) {
            return [];
        }

        return [
            {
                entryIndex: item.entryIndex,
                start: item.start,
                end: item.end,
                highlightText: item.highlightText,
                sourceText: entry.text,
            },
        ];
    });

    return filterValidSubtitleHighlights(entries, highlights);
}
