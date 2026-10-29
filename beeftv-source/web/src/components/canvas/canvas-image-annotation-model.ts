export type AnnotationPoint = { x: number; y: number };
export type AnnotationOperation =
    | { type: "brush"; color: string; size: number; points: AnnotationPoint[] }
    | { type: "rectangle"; color: string; size: number; x: number; y: number; width: number; height: number }
    | { type: "text"; color: string; size: number; x: number; y: number; text: string };

export type AnnotationHistory = { items: AnnotationOperation[]; redo: AnnotationOperation[] };

export function normalizeAnnotationRect(start: AnnotationPoint, end: AnnotationPoint) {
    return { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
}

export const annotationHistory = {
    empty: (): AnnotationHistory => ({ items: [], redo: [] }),
    push: (history: AnnotationHistory, operation: AnnotationOperation): AnnotationHistory => ({ items: [...history.items, operation], redo: [] }),
    undo: (history: AnnotationHistory): AnnotationHistory => (history.items.length ? { items: history.items.slice(0, -1), redo: [...history.redo, history.items[history.items.length - 1]] } : history),
    redo: (history: AnnotationHistory): AnnotationHistory => (history.redo.length ? { items: [...history.items, history.redo[history.redo.length - 1]], redo: history.redo.slice(0, -1) } : history),
};
