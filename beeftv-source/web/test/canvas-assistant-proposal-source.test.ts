import { describe, expect, test } from "bun:test";

import { assistantProposalHasUnconfirmedEdits, modelConfigHasUnconfirmedEdits } from "@/pages/canvas/canvas-assistant-proposal-source";

describe("assistantProposalHasUnconfirmedEdits", () => {
    test("blocks confirmation while the canvas or model config is still dirty", () => {
        expect(assistantProposalHasUnconfirmedEdits({ canvasDirty: true, modelConfigDirty: false, modelConfigStatus: "idle" })).toBe(true);
        expect(assistantProposalHasUnconfirmedEdits({ canvasDirty: false, modelConfigDirty: true, modelConfigStatus: "saved" })).toBe(true);
        expect(assistantProposalHasUnconfirmedEdits({ canvasDirty: false, modelConfigDirty: false, modelConfigStatus: "saving" })).toBe(true);
    });

    test("allows confirmation only after canvas and model config are idle or saved", () => {
        expect(assistantProposalHasUnconfirmedEdits({ canvasDirty: false, modelConfigDirty: false, modelConfigStatus: "idle" })).toBe(false);
        expect(assistantProposalHasUnconfirmedEdits({ canvasDirty: false, modelConfigDirty: false, modelConfigStatus: "saved" })).toBe(false);
    });

    test("separates canvas edits, model edits and model save/read failure without relaxing the gate", () => {
        expect(modelConfigHasUnconfirmedEdits({ modelConfigDirty: true, modelConfigStatus: "saving" })).toBe(true);
        expect(modelConfigHasUnconfirmedEdits({ modelConfigDirty: true, modelConfigStatus: "saved" })).toBe(true);
        for (const status of ["saving", "hydrating", "error"]) {
            expect(modelConfigHasUnconfirmedEdits({ modelConfigDirty: false, modelConfigStatus: status })).toBe(true);
            expect(assistantProposalHasUnconfirmedEdits({ canvasDirty: false, modelConfigDirty: false, modelConfigStatus: status })).toBe(true);
        }
    });
});
