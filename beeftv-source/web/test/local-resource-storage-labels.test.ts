import { describe, expect, test } from "bun:test";

import { resourceStorageLabel, resourceStorageLocation, resourceStorageTitle } from "../src/lib/canvas/resource-storage-status";

describe("local resource storage labels", () => {
    test("describes resource keys as local in local runtime", () => {
        expect(resourceStorageLocation("resource:asset-1", true)).toBe("local");
        expect(resourceStorageLabel("resource:asset-1", true)).toBe("本地");
        expect(resourceStorageTitle("resource:asset-1", true)).toBe("保存在本机资源目录");
    });

    test("does not present an empty local key as cloud sync failure", () => {
        expect(resourceStorageLabel("", true)).toBe("未保存");
        expect(resourceStorageTitle("", true)).toBe("还没有可用的资源标识");
    });

    test("keeps hosted object-storage labels unchanged", () => {
        expect(resourceStorageLocation("resource:asset-1", false)).toBe("oss");
        expect(resourceStorageLabel("resource:asset-1", false)).toBe("已上传");
        expect(resourceStorageTitle("resource:asset-1", false)).toContain("对象存储");
    });
});
