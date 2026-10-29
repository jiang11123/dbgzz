export function selectDirectorRecordingMimeType(isTypeSupported: (type: string) => boolean): string {
    return ["video/mp4;codecs=avc1.42E01E", "video/mp4", "video/webm;codecs=vp8", "video/webm;codecs=vp9", "video/webm"].find(isTypeSupported) || "";
}

export function waitForDirectorDecodedFrame(video: HTMLVideoElement, timeoutMs = 8_000): Promise<void> {
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            clearTimeout(timer);
            video.removeEventListener("loadeddata", onReady);
            video.removeEventListener("error", onError);
        };
        const onReady = () => { cleanup(); resolve(); };
        const onError = () => { cleanup(); reject(new Error("白膜视频无法解码，请重试或检查系统视频格式支持")); };
        const timer = setTimeout(() => { cleanup(); reject(new Error("白膜视频首帧解码超时，请重试")); }, timeoutMs);
        video.addEventListener("loadeddata", onReady, { once: true });
        video.addEventListener("error", onError, { once: true });
    });
}
