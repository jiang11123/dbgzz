import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import { CanvasDeleteProjectsDialog } from "../../src/components/canvas/canvas-delete-projects-dialog";
import { useCanvasUiStore } from "../../src/stores/canvas/use-canvas-ui-store";
import { setActiveUserScope } from "../../src/lib/user-scope";

setActiveUserScope("owner-a");
(window as any).__deletion = {
    select: (ids: string[]) => useCanvasUiStore.getState().setDeleteProjectIds(ids),
    switchScope: (id: string) => setActiveUserScope(id),
};
function Harness() {
    const ids = useCanvasUiStore(state => state.deleteProjectIds);
    return <ConfigProvider button={{ autoInsertSpace: false }}><App><button onClick={() => useCanvasUiStore.getState().setDeleteProjectIds(["c1"])}>删除单个</button>
        <button onClick={() => useCanvasUiStore.getState().setDeleteProjectIds(["c1", "c2"])}>批量删除</button>
        {ids.length ? <CanvasDeleteProjectsDialog /> : null}</App></ConfigProvider>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
