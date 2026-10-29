import { expect, test } from "bun:test";
import { seedanceOutputWarning } from "../src/lib/seedance-output-warning";
import publicInput from "./fixtures/seedance-public-input.json";
import { seedanceTaskRetryWarning } from "../src/lib/seedance-channel-warning";

test("public task output preserves comparison and paid retry confirmation without secrets", () => {
    expect(seedanceOutputWarning(JSON.stringify(publicInput),960,960)).toContain("要求 16:9");
    expect(seedanceTaskRetryWarning(JSON.stringify(publicInput))?.okText).toBe("接受风险并生成");
    expect(seedanceTaskRetryWarning(JSON.stringify({...publicInput,videoParameters:{...publicInput.videoParameters,affectedChannel:false}}))).toBeUndefined();
});

const input = {config:{model:"seedance-2.5",size:"16:9"},metadata:{videoEditOperation:"reference_to_video"},referenceVideos:[{id:"v"}]};
test("output mismatch is visible without converting success into a retry", () => {
    expect(seedanceOutputWarning(JSON.stringify({...input,config:{size:"16:9"}}),960,960,"seedance-2.5")).toContain("要求 16:9");
    expect(seedanceOutputWarning(JSON.stringify(input),960,960)).toContain("要求 16:9，实际 960×960");
    expect(seedanceOutputWarning(JSON.stringify(input),1280,720)).toBeUndefined();
    expect(seedanceOutputWarning(JSON.stringify(input),1280,728)).toBeUndefined();
    expect(seedanceOutputWarning(JSON.stringify(input),undefined,undefined)).toBeUndefined();
    expect(seedanceOutputWarning("invalid",960,960)).toBeUndefined();
});
test("native first-frame and edit do not inherit a stale selected ratio", () => {
    expect(seedanceOutputWarning(JSON.stringify({...input,metadata:{},referenceVideos:[],referenceImages:[{id:"f"}]}),960,960)).toBeUndefined();
    expect(seedanceOutputWarning(JSON.stringify({...input,metadata:{videoEditOperation:"inpaint"}}),960,960)).toBeUndefined();
    expect(seedanceOutputWarning(JSON.stringify({...input,config:{model:"seedance-2.0",size:"16:9"}}),960,960)).toBeDefined();
});
