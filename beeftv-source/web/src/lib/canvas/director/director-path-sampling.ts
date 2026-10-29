export type DirectorGroundPathPoint = { x: number; z: number };

/**
 * Convert a freehand polyline into a fixed number of editable nodes by arc length.
 * The user's sampled pointer events stay an implementation detail; only the
 * normalized nodes are persisted as path keyframes.
 */
export function resampleDirectorGroundPath(points: DirectorGroundPathPoint[], controlPointCount = 10): DirectorGroundPathPoint[] {
    const clean = points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.z))
        .filter((point, index, all) => index === 0 || Math.hypot(point.x - all[index - 1].x, point.z - all[index - 1].z) > 1e-6);
    if (clean.length < 2) return clean;

    const cumulative = [0];
    for (let index = 1; index < clean.length; index += 1) {
        cumulative.push(cumulative[index - 1] + Math.hypot(clean[index].x - clean[index - 1].x, clean[index].z - clean[index - 1].z));
    }
    const length = cumulative.at(-1) || 0;
    if (length <= 1e-6) return [clean[0]];

    const segments = Math.max(1, Math.min(127, Math.round(controlPointCount) - 1));
    return Array.from({ length: segments + 1 }, (_, index) => {
        const distance = length * index / segments;
        let segment = 1;
        while (segment < cumulative.length - 1 && cumulative[segment] < distance) segment += 1;
        const startDistance = cumulative[segment - 1];
        const segmentLength = cumulative[segment] - startDistance;
        const amount = segmentLength > 1e-6 ? (distance - startDistance) / segmentLength : 0;
        return {
            x: clean[segment - 1].x + (clean[segment].x - clean[segment - 1].x) * amount,
            z: clean[segment - 1].z + (clean[segment].z - clean[segment - 1].z) * amount,
        };
    });
}
