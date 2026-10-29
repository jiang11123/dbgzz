import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

const assets = readFileSync(resolve(import.meta.dir, "../src/pages/assets/index.tsx"), "utf8");
const imageStorage = readFileSync(resolve(import.meta.dir, "../src/services/image-storage.ts"), "utf8");
const fileStorage = readFileSync(resolve(import.meta.dir, "../src/services/file-storage.ts"), "utf8");
const localMediaRepository = readFileSync(resolve(import.meta.dir, "../src/services/local-media-repository.ts"), "utf8");
const resourceStorageMode = readFileSync(resolve(import.meta.dir, "../src/services/workspace-resource-storage.ts"), "utf8");

describe("local asset upload semantics", () => {
    test("uses local copy while preserving remote upload wording", () => {
        expect(assets).toContain('{imageUploading ? (remoteMode ? "正在上传图片" : "正在保存图片") : "选择图片文件"}');
        expect(assets).toContain('remoteMode ? "正在上传到云端" : "正在保存到本地"');
    });

    test("browser-local files stay canonical; desktop IndexedDB fallback reports pending", () => {
        expect(imageStorage).toContain("pendingRemoteUpload: true");
        expect(fileStorage).toContain("pendingRemoteUpload: true");
        expect(imageStorage).not.toContain("pendingRemoteUpload: localRuntime ? undefined : true");
        expect(fileStorage).not.toContain("pendingRemoteUpload: localRuntime ? undefined : true");
        expect(imageStorage).toContain("usesBrowserLocalResourceStore()");
        expect(fileStorage).toContain("usesBrowserLocalResourceStore()");
        expect(resourceStorageMode).toContain("isNativeDesktopRuntime");
        expect(imageStorage).toContain("await store.setItem(storageKey, blob);");
        expect(fileStorage).toContain('from "@/services/local-media-repository"');
        expect(localMediaRepository).toContain("saveLocalMedia");
        expect(localMediaRepository).toContain("localForageInstance(MEDIA_FILES_STORE_NAME)");
    });

    test("3D model fallback uses hosted-only remote wording", () => {
        expect(assets).toContain("等待远端同步");
        expect(assets).not.toContain("尚未上传到服务器");
    });
});
