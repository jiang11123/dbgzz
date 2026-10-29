import { useState } from "react";
import { createRoot } from "react-dom/client";
import { GenerationFailureNotice } from "../../src/components/generation/generation-failure-notice";
import { explainGenerationError, type GenerationFailureExplanation } from "../../src/lib/generation-error";
import { http } from "../../src/services/api/request";

function Harness() {
    const [failure, setFailure] = useState<GenerationFailureExplanation>();
    const [retries, setRetries] = useState(0);
    const submit = async () => {
        try {
            await http.post("/tasks", { type: "canvas_image", prompt: "fixture" });
        } catch (error) {
            setFailure(explainGenerationError(error));
        }
    };
    return <main>
        <button onClick={() => void submit()}>提交测试任务</button>
        {failure ? <section aria-label="生成错误" data-category={failure.category}>
            <GenerationFailureNotice explanation={failure} onRetry={() => setRetries((value) => value + 1)} />
        </section> : null}
        <output aria-label="重试次数">{retries}</output>
    </main>;
}

createRoot(document.getElementById("root")!).render(<Harness />);
