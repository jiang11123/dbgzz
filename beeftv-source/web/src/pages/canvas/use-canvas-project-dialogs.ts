import { useCallback, useRef, useState } from "react";

export type CanvasProjectDialogIds = {
    textEditorNodeId: string | null;
    characterReferenceNodeId: string | null;
    drawingNodeId: string | null;
    infoNodeId: string | null;
    subtitleNodeId: string | null;
    timelineNodeId: string | null;
    previewNodeId: string | null;
    scriptEditorNodeId: string | null;
    artCritiqueNodeId: string | null;
    directorNodeId: string | null;
    versionCompareRootId: string | null;
};

export const CANVAS_DELETE_DIALOG_ID_KEYS = [
    "textEditorNodeId",
    "characterReferenceNodeId",
    "drawingNodeId",
    "infoNodeId",
    "subtitleNodeId",
    "previewNodeId",
    "scriptEditorNodeId",
    "artCritiqueNodeId",
    "directorNodeId",
    "versionCompareRootId",
] as const satisfies readonly (keyof CanvasProjectDialogIds)[];

export function clearDeletedCanvasDialogIds<T extends Record<(typeof CANVAS_DELETE_DIALOG_ID_KEYS)[number], string | null>>(ids: T, removedIds: Set<string>): T {
    let changed = false;
    const next = { ...ids };
    for (const key of CANVAS_DELETE_DIALOG_ID_KEYS) {
        const current = ids[key];
        if (current && removedIds.has(current)) {
            next[key] = null as T[typeof key];
            changed = true;
        }
    }
    return changed ? next : ids;
}

export function useCanvasProjectDialogs() {
    const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
    const [generationHistoryOpen, setGenerationHistoryOpen] = useState(false);
    const [tapNowImportOpen, setTapNowImportOpen] = useState(false);
    const [nodeSearchOpen, setNodeSearchOpen] = useState(false);
    const [stylePickerOpen, setStylePickerOpen] = useState(false);
    const [libTVImportOpen, setLibTVImportOpen] = useState(false);
    const [textEditorNodeId, setTextEditorNodeId] = useState<string | null>(null);
    const [characterReferenceNodeId, setCharacterReferenceNodeId] = useState<string | null>(null);
    const [drawingNodeId, setDrawingNodeId] = useState<string | null>(null);
    const [infoNodeId, setInfoNodeId] = useState<string | null>(null);
    const [subtitleNodeId, setSubtitleNodeId] = useState<string | null>(null);
    const [timelineNodeId, setTimelineNodeId] = useState<string | null>(null);
    const [previewNodeId, setPreviewNodeId] = useState<string | null>(null);
    const [scriptEditorNodeId, setScriptEditorNodeId] = useState<string | null>(null);
    const [artCritiqueNodeId, setArtCritiqueNodeId] = useState<string | null>(null);
    const artCritiqueRunningRef = useRef(false);
    const [artCritiqueStartRequest, setArtCritiqueStartRequest] = useState<{ nodeId: string; id: string; restart: boolean } | null>(null);
    const [directorNodeId, setDirectorNodeId] = useState<string | null>(null);
    const [versionCompareRootId, setVersionCompareRootId] = useState<string | null>(null);

    const clearDeletedNodeIds = useCallback((removedIds: Set<string>) => {
        const clearDeletedId = (current: string | null) => (current && removedIds.has(current) ? null : current);
        setTextEditorNodeId(clearDeletedId);
        setCharacterReferenceNodeId(clearDeletedId);
        setDrawingNodeId(clearDeletedId);
        setInfoNodeId(clearDeletedId);
        setSubtitleNodeId(clearDeletedId);
        setPreviewNodeId(clearDeletedId);
        setScriptEditorNodeId(clearDeletedId);
        setArtCritiqueNodeId(clearDeletedId);
        setDirectorNodeId(clearDeletedId);
        setVersionCompareRootId(clearDeletedId);
    }, []);

    const resetForClearCanvas = useCallback(() => {
        setTextEditorNodeId(null);
        setDrawingNodeId(null);
        setInfoNodeId(null);
        setSubtitleNodeId(null);
        setPreviewNodeId(null);
        setArtCritiqueNodeId(null);
        setClearConfirmOpen(false);
    }, []);

    return {
        clearConfirmOpen,
        setClearConfirmOpen,
        generationHistoryOpen,
        setGenerationHistoryOpen,
        tapNowImportOpen,
        setTapNowImportOpen,
        nodeSearchOpen,
        setNodeSearchOpen,
        stylePickerOpen,
        setStylePickerOpen,
        libTVImportOpen,
        setLibTVImportOpen,
        textEditorNodeId,
        setTextEditorNodeId,
        characterReferenceNodeId,
        setCharacterReferenceNodeId,
        drawingNodeId,
        setDrawingNodeId,
        infoNodeId,
        setInfoNodeId,
        subtitleNodeId,
        setSubtitleNodeId,
        timelineNodeId,
        setTimelineNodeId,
        previewNodeId,
        setPreviewNodeId,
        scriptEditorNodeId,
        setScriptEditorNodeId,
        artCritiqueNodeId,
        setArtCritiqueNodeId,
        artCritiqueRunningRef,
        artCritiqueStartRequest,
        setArtCritiqueStartRequest,
        directorNodeId,
        setDirectorNodeId,
        versionCompareRootId,
        setVersionCompareRootId,
        clearDeletedNodeIds,
        resetForClearCanvas,
    };
}
