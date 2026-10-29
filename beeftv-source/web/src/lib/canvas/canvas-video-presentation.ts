type CanvasVideoPresentationInput = {
    active: boolean;
    hasSource: boolean;
    firstFramePresented: boolean;
};

export function canvasVideoPresentationState({ active, hasSource, firstFramePresented }: CanvasVideoPresentationInput) {
    const showVideo = active && hasSource && firstFramePresented;
    return {
        showPoster: !showVideo,
        showVideo,
        showLoading: active && !hasSource,
    };
}
