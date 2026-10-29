import React from "react";
import { createRoot } from "react-dom/client";
import { ConfigProvider, theme } from "antd";
import { EnvironmentChecks } from "../../src/pages/settings/environment-checks";
import { createClientId } from "../../src/lib/client-id";
import { runStartupEnvironmentCheck } from "../../src/services/diagnostics/environment-startup";

const dark = new URL(location.href).searchParams.has("dark");
document.documentElement.classList.toggle("dark", dark);
Object.assign(window, { createTestBusinessID: createClientId, runStartupEnvironmentCheck });
createRoot(document.getElementById("root")!).render(<ConfigProvider theme={{ algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm }}><div className="mx-auto max-w-xl bg-background p-5 text-foreground"><EnvironmentChecks /></div></ConfigProvider>);
