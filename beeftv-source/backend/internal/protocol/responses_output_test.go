package protocol

import (
	"context"
	"testing"
)

func TestOfficialResponsesCollectsStandardOutputAndPreservesTools(t *testing.T) {
	adapter := officialPackageAdapter(t, "openai-responses.beeftv-plugin", "openai-response")
	payload := []byte(`{"status":"completed","output":[{"type":"reasoning","summary":[{"type":"summary_text","text":"brief summary"}]},{"type":"function_call","call_id":"call-test","name":"canvas_get_state","arguments":"{}"},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Hello "},{"type":"output_text","text":"world"}]},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"!"}]}]}`)
	created, err := adapter.ParseCreate(context.Background(), payload)
	if err != nil || created.Result == nil || created.Result.Text != "Hello world!" || created.Result.Reasoning != "brief summary" {
		t.Fatalf("standard Responses output lost: %#v err=%v", created, err)
	}
	agent, ok := adapter.(AgentAdapter)
	if !ok {
		t.Fatal("Responses agent adapter missing")
	}
	result, err := agent.ParseAgent(context.Background(), payload)
	if err != nil || result.Text != "Hello world!" || result.Reasoning != "brief summary" || len(result.ToolCalls) != 1 || result.ToolCalls[0].ID != "call-test" {
		t.Fatalf("agent Responses output changed: %#v err=%v", result, err)
	}
}

func TestManifestTextPathFallbackDoesNotDuplicateText(t *testing.T) {
	payload := map[string]any{"output_text": "complete answer", "output": []any{map[string]any{"content": []any{map[string]any{"text": "complete answer"}}}}}
	if got := firstPathValue(payload, "output_text", "output.*.content.*.text"); got != "complete answer" {
		t.Fatalf("fallback duplicated text: %q", got)
	}
	if got := firstPathValue(payload, "missing.*.content.*.text", "output_text"); got != "complete answer" {
		t.Fatalf("empty wildcard prevented fallback: %q", got)
	}
}
