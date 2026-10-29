import { createRoot } from "react-dom/client";
import { WorkspaceBootstrapHydrator } from "@/components/workspace/workspace-bootstrap-hydrator";
createRoot(document.getElementById("root")!).render(<WorkspaceBootstrapHydrator><button>开始创作</button></WorkspaceBootstrapHydrator>);
