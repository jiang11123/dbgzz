import { useCallback, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import { EditorStoreProvider } from "../../src/components/editor/editor-context";
import { EditorAssetIngest } from "../../src/lib/plugins/builtin/editor/editor-asset-ingest";
import { normalizeTimelineProject } from "../../src/lib/timeline/timeline-tracks";
import { setActiveUserScope } from "@/lib/user-scope";
import { captureUserScope } from "@/lib/user-scope-guard";
import type { ProjectAsset } from "../../src/services/api/projects";
import { createEditorStore } from "../../src/stores/editor/editor-store";
import { createEditorAssetIngestDoubles, type EditorAssetIngestDoubles } from "./editor-asset-ingest-doubles";

type HarnessWindow = Window & {
    __editorAssetIngestDoubles?: EditorAssetIngestDoubles;
    __editorAssetIngestHarness?: {
        doubles: EditorAssetIngestDoubles;
        assets: ProjectAsset[];
        projectId: string;
        switchABA: () => void;
        switchProject: () => void;
        remountEditor: () => void;
    };
};

const harnessWindow = window as HarnessWindow;

setActiveUserScope("owner-a");
const doubles = createEditorAssetIngestDoubles();
harnessWindow.__editorAssetIngestDoubles = doubles;

function Harness() {
    const store = useMemo(() => {
        const created = createEditorStore({ saveTimeline: async () => {} });
        created.getState().load(normalizeTimelineProject({ version: 2, tracks: [], clips: [], durationMs: 0 }));
        return created;
    }, []);
    const [projectId, setProjectId] = useState("project-a");
    const [editorKey, setEditorKey] = useState(0);
    const [assets, setAssets] = useState<ProjectAsset[]>([]);

    const refreshAssets = useCallback(async () => {
        doubles.calls.push({
            phase: "enter",
            step: "refresh",
            projectId,
            liveScope: captureUserScope(),
        });
        if (doubles.hold.refresh) await doubles.gates.refresh.promise;
        if (doubles.switched) {
            doubles.refreshAfterSwitch += 1;
            return null;
        }
        if (doubles.fail.refresh) return null;
        doubles.calls.push({
            phase: "write",
            step: "refresh",
            projectId,
            liveScope: captureUserScope(),
        });
        const list = doubles.linked.slice();
        setAssets(list);
        return list;
    }, [projectId]);

    harnessWindow.__editorAssetIngestHarness = {
        doubles,
        assets,
        projectId,
        switchABA: () => {
            doubles.switched = true;
            setActiveUserScope("owner-b");
            setActiveUserScope("owner-a");
        },
        switchProject: () => {
            setProjectId("project-b");
            setAssets([]);
        },
        remountEditor: () => setEditorKey((key) => key + 1),
    };

    return (
        <div style={{ height: "100vh" }}>
            <EditorStoreProvider store={store} host={{ projectId, assets, refreshAssets }}>
                <EditorAssetIngest key={editorKey} />
            </EditorStoreProvider>
            <p data-testid="project-id">{projectId}</p>
            <p data-testid="asset-ids">{assets.map((asset) => asset.id).join(",")}</p>
        </div>
    );
}

createRoot(document.getElementById("root")!).render(<Harness />);
