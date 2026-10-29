import { expect, test } from "bun:test";

import { parseCanvasStorageDocument } from "../src/lib/canvas/canvas-storage-revision";

test("loads older canvas records without node arrays so later persistence can continue", () => {
    const document = parseCanvasStorageDocument(JSON.stringify({
        state: {
            projects: [{ id: "legacy-canvas", title: "Legacy canvas" }],
        },
    }));

    expect(document.state.projects).toHaveLength(1);
    expect(document.state.projects[0].title).toBe("Legacy canvas");
    expect(document.state.projects[0].nodes).toEqual([]);
});
