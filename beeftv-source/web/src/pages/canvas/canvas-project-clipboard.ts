import { getCachedResourceBlob } from "@/services/resource-blob-cache";

export async function copyImageToSystemClipboard(source: string, storageKey?: string) {
    if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) throw new Error("当前浏览器不支持复制图片");
    if (typeof window !== "undefined") window.focus();

    const fetchPNG = async (): Promise<Blob> => {
        let sourceBlob: Blob | null = null;
        if (storageKey) {
            sourceBlob = await getCachedResourceBlob(storageKey).catch(() => null);
        }
        if (!sourceBlob) {
            const response = await fetch(source);
            if (!response.ok) throw new Error(`图片读取失败（HTTP ${response.status}）`);
            sourceBlob = await response.blob();
        }
        return sourceBlob.type === "image/png" ? sourceBlob : await convertClipboardImageToPNG(sourceBlob);
    };

    // 优先尝试将 Promise 直接传给 ClipboardItem（现代浏览器标准），在用户激活手势内立即声明写入，
    // 避免因 fetch / 格式转换耗时导致手势过期或窗口失焦抛出 "Document is not focused" 错误。
    try {
        const item = new ClipboardItem({ "image/png": fetchPNG() });
        await navigator.clipboard.write([item]);
        return;
    } catch {
        // 部分浏览器环境不支持延迟 Promise，回退到先取 Blob 再写入
    }

    const blob = await fetchPNG();
    if (typeof window !== "undefined") window.focus();
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}

export async function convertClipboardImageToPNG(blob: Blob) {
    if (typeof createImageBitmap !== "function") throw new Error("当前浏览器无法转换这张图片的格式");
    const bitmap = await createImageBitmap(blob);
    try {
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("当前浏览器无法处理这张图片");
        context.drawImage(bitmap, 0, 0);
        return await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("图片格式转换失败"))), "image/png"));
    } finally {
        bitmap.close();
    }
}
