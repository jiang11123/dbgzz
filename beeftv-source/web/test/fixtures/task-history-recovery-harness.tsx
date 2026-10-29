import { createRoot } from "react-dom/client";
import { App } from "antd";
import { MemoryRouter } from "react-router";
import TasksPage from "../../src/pages/tasks";
import { useCanvasStore } from "../../src/stores/canvas/use-canvas-store";
import { CanvasNodeType } from "../../src/types/canvas";

await useCanvasStore.persist.rehydrate();
useCanvasStore.setState({ projects: [{ id: "canvas", title: "test canvas", nodes: ["a", "b"].map((id) => ({ id, type: CanvasNodeType.Video, title: id, x: 0, y: 0, width: 320, height: 180, metadata: { taskId: id, taskStatus: "failed", prompt: `task ${id}`, status: "error" } })), connections: [], chatSessions: [], activeChatId: null, viewport: { x: 0, y: 0, k: 1 }, createdAt: "2026-10-01", updatedAt: "2026-10-01" }] });
createRoot(document.getElementById("root")!).render(<MemoryRouter><App><TasksPage /></App></MemoryRouter>);
