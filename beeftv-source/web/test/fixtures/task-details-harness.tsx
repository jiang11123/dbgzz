import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useTaskDetails } from "../../src/hooks/use-task-details";

function Harness() {
    const [id, setId] = useState<string>();
    const query = useTaskDetails(id, "test-canvas");
    return <>
        {["a", "b", "local:legacy"].map((value) => <button key={value} onClick={() => setId(value)}>{value}</button>)}
        <button onClick={() => setId(undefined)}>close</button>
        <button onClick={() => window.dispatchEvent(new CustomEvent("canvas:task-cancelled", { detail: { task: { ...query.data?.task, id, status: "cancelled", completedAt: "2026-09-29T15:00:03Z" } } }))}>cancel event</button>
        <pre id="snapshot">{JSON.stringify({ id, data: query.data, loading: query.isLoading, error: query.isError })}</pre>
    </>;
}

createRoot(document.getElementById("root")!).render(<QueryClientProvider client={new QueryClient()}><Harness /></QueryClientProvider>);
