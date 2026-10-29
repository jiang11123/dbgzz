import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import { startCheckedWorkspace } from "@/services/diagnostics/startup-preflight";

void startCheckedWorkspace(() => import("./bootstrap-workspace").then((module) => module.startApplication()));
