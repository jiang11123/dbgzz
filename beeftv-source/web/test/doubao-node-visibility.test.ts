import { expect, test } from "bun:test";
import { resolveAddNodeMenuCommands, type AddNodeMenuContext } from "@/lib/canvas/tool-registry";
import "@/lib/canvas/tool-registry/definitions/add-node-menu-tools";
import { createModelChannel, defaultConfig, normalizeConfigSnapshot, selectableModelsByCapability } from "@/stores/use-config-store";

const context: AddNodeMenuContext = {
    workspaceMode: "professional",
    isProjectLinked: false,
    handlers: {} as AddNodeMenuContext["handlers"],
};

test("independent Doubao nodes are opt-in while original creation commands remain", () => {
    const hidden = resolveAddNodeMenuCommands(context).map(command => command.id);
    expect(hidden.filter(id => id.startsWith("doubao-"))).toEqual([]);
    for (const id of ["text", "image", "video"]) expect(hidden).toContain(id);
    const visible = resolveAddNodeMenuCommands({ ...context, showDoubaoNodes: true }).map(command => command.id);
    expect(visible.filter(id => id.startsWith("doubao-"))).toEqual(["doubao-text-preset", "doubao-image-preset", "doubao-video-preset"]);
    expect(resolveAddNodeMenuCommands({ ...context, showDoubaoNodes: false }).map(command => command.id)).toEqual(hidden);
});

test("native nodes can explicitly select each Doubao account capability without changing API defaults", () => {
    const channel = createModelChannel({
        id: "doubao-gateway", apiFormat: "openai",
        models: ["doubao-account-1", "doubao-image-account-1", "doubao-video-account-1"],
        modelProfiles: [
            { model: "doubao-account-1", capability: "text", protocol: "chat-completion" },
            { model: "doubao-image-account-1", capability: "image", protocol: "doubao-gateway-image" },
            { model: "doubao-video-account-1", capability: "video", protocol: "doubao-gateway-video" },
        ],
    });
    const config = normalizeConfigSnapshot({ config: { ...defaultConfig, channels: [channel], models: [], textModel: "", imageModel: "", videoModel: "" } }).config;
    expect(config.textModel).toBe("");
    expect(config.imageModel).toBe("");
    expect(config.videoModel).toBe("");
    expect(selectableModelsByCapability(config, "text")).toEqual(["doubao-gateway::doubao-account-1"]);
    expect(selectableModelsByCapability(config, "image")).toEqual(["doubao-gateway::doubao-image-account-1"]);
    expect(selectableModelsByCapability(config, "video")).toEqual(["doubao-gateway::doubao-video-account-1"]);
});
