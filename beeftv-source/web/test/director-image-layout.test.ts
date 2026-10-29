import { describe, expect, test } from "bun:test";

import { parseDirectorImageLayout } from "@/lib/canvas/director/director-image-layout";

describe("导演台图片站位识别结果", () => {
    test("解析 JSON 与代码围栏并限制坐标和数量", () => {
        const parsed = parseDirectorImageLayout('```json\n{"elements":[{"name":"人物 A","type":"person","x":0.25,"depth":0.7},{"name":"桌子","type":"object","x":1.4,"depth":-0.2}]}\n```');
        expect(parsed).toEqual([
            { name: "人物 A", type: "person", x: 0.25, depth: 0.7 },
            { name: "桌子", type: "object", x: 1, depth: 0 },
        ]);
    });

    test("拒绝缺字段、未知类型和无效 JSON", () => {
        expect(() => parseDirectorImageLayout("not json")).toThrow("识图结果格式无效");
        expect(() => parseDirectorImageLayout('{"elements":[{"name":"x","type":"vehicle","x":0.5,"depth":0.5}]}')).toThrow("未识别到可用的人物或物体");
        expect(() => parseDirectorImageLayout('{"elements":[]}')).toThrow("未识别到可用的人物或物体");
    });
});
