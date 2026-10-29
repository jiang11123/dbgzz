package operations

import (
	"encoding/json"
	"testing"
)

type proposeProbe struct {
	unusedDomain
	doc     json.RawMessage
	calls   [][2]string
	resolve func(kind, selected string) (AssistantGenerationModel, error)
}

func (p *proposeProbe) UserCanvasProject(string, string) (json.RawMessage, error) {
	return p.doc, nil
}

func (p *proposeProbe) ResolveAssistantGenerationModel(kind, selected string) (AssistantGenerationModel, error) {
	p.calls = append(p.calls, [2]string{kind, selected})
	if p.resolve != nil {
		return p.resolve(kind, selected)
	}
	return AssistantGenerationModel{Display: "gpt-image-2", ModelKey: "beefapi::gpt-image-2", Revision: 1}, nil
}

func proposeCanvas(t *testing.T, nodes []map[string]any) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(map[string]any{"id": "c1", "revision": 4, "nodes": nodes, "connections": []any{}})
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func imageNode(id, model string) map[string]any {
	metadata := map[string]any{"prompt": id}
	if model != "" {
		metadata["model"] = model
	}
	return map[string]any{"id": id, "type": "image", "title": id, "metadata": metadata}
}

func TestOpGenerationProposeUsesNodeOverrideBeforeDefault(t *testing.T) {
	probe := &proposeProbe{doc: proposeCanvas(t, []map[string]any{
		imageNode("n1", "beefapi::gpt-image-2.5-flare"),
	})}
	probe.resolve = func(kind, selected string) (AssistantGenerationModel, error) {
		if kind != "image" || selected != "beefapi::gpt-image-2.5-flare" {
			t.Fatalf("expected node selection, got kind=%s selected=%s", kind, selected)
		}
		return AssistantGenerationModel{Display: "gpt-image-2.5-flare", ModelKey: selected, Revision: 9}, nil
	}
	result, err := opCanvasGenerationPropose(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{"canvasId":"c1","nodeIds":["n1"],"kind":"image"}`))
	if err != nil {
		t.Fatal(err)
	}
	payload := result.(map[string]any)
	if payload["model"] != "gpt-image-2.5-flare" || payload["modelKey"] != "beefapi::gpt-image-2.5-flare" {
		t.Fatalf("proposal should use node override: %#v", payload)
	}
	source := payload["source"].(map[string]any)
	if source["modelConfigRevision"] != int64(9) || source["canvasRevision"] != float64(4) {
		t.Fatalf("source binding: %#v", source)
	}
}

func TestOpGenerationProposeFallsBackToDefaultWithoutNodeModel(t *testing.T) {
	probe := &proposeProbe{doc: proposeCanvas(t, []map[string]any{imageNode("n1", ""), imageNode("n2", "")})}
	result, err := opCanvasGenerationPropose(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{"canvasId":"c1","nodeIds":["n1","n2"],"kind":"image"}`))
	if err != nil {
		t.Fatal(err)
	}
	payload := result.(map[string]any)
	if payload["modelKey"] != "beefapi::gpt-image-2" {
		t.Fatalf("empty node model should use default: %#v", payload)
	}
	if len(probe.calls) != 2 || probe.calls[0][1] != "" || probe.calls[1][1] != "" {
		t.Fatalf("should resolve empty selections: %#v", probe.calls)
	}
}

func TestOpGenerationProposeRejectsUnavailableExplicitModel(t *testing.T) {
	probe := &proposeProbe{doc: proposeCanvas(t, []map[string]any{imageNode("n1", "removed::image")})}
	probe.resolve = func(string, string) (AssistantGenerationModel, error) {
		return AssistantGenerationModel{Revision: 1}, nil
	}
	result, err := opCanvasGenerationPropose(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{"canvasId":"c1","nodeIds":["n1"],"kind":"image"}`))
	if err == nil || result != nil || AsError(err).Reason != "generation_model_unavailable" {
		t.Fatalf("unavailable explicit model must not produce a paid proposal: result=%v err=%v", result, err)
	}
}

func TestOpGenerationProposeRejectsMixedNodeModels(t *testing.T) {
	probe := &proposeProbe{doc: proposeCanvas(t, []map[string]any{
		imageNode("n1", "beefapi::gpt-image-2.5-flare"),
		imageNode("n2", ""),
	})}
	probe.resolve = func(kind, selected string) (AssistantGenerationModel, error) {
		if selected == "beefapi::gpt-image-2.5-flare" {
			return AssistantGenerationModel{Display: "gpt-image-2.5-flare", ModelKey: selected, Revision: 1}, nil
		}
		return AssistantGenerationModel{Display: "gpt-image-2", ModelKey: "beefapi::gpt-image-2", Revision: 1}, nil
	}
	_, err := opCanvasGenerationPropose(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{"canvasId":"c1","nodeIds":["n1","n2"],"kind":"image"}`))
	if err == nil {
		t.Fatal("mixed models must be rejected")
	}
	opErr := AsError(err)
	if opErr.Reason != "mixed_generation_models" || opErr.Code != CodeInvalidArgument {
		t.Fatalf("mixed models reason: %v", err)
	}
}

func TestOpGenerationProposeRejectsConfigRevisionDrift(t *testing.T) {
	probe := &proposeProbe{doc: proposeCanvas(t, []map[string]any{
		imageNode("n1", "beefapi::gpt-image-2"),
		imageNode("n2", "beefapi::gpt-image-2"),
	})}
	probe.resolve = func(string, string) (AssistantGenerationModel, error) {
		return AssistantGenerationModel{
			Display:  "gpt-image-2",
			ModelKey: "beefapi::gpt-image-2",
			Revision: int64(len(probe.calls)),
		}, nil
	}
	_, err := opCanvasGenerationPropose(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{"canvasId":"c1","nodeIds":["n1","n2"],"kind":"image"}`))
	if err == nil {
		t.Fatal("same model keys with drifted config revision must be rejected")
	}
	opErr := AsError(err)
	if opErr.Reason != "generation_config_changed" || opErr.Code != CodePreconditionFailed {
		t.Fatalf("config revision drift: %v", err)
	}
	if len(probe.calls) != 2 {
		t.Fatalf("both nodes must be resolved before reject: %#v", probe.calls)
	}
}

func TestOpGenerationProposeRejectsKindMismatch(t *testing.T) {
	videoNode := imageNode("n1", "beefapi::wan3.0-video")
	videoNode["type"] = "video"
	probe := &proposeProbe{doc: proposeCanvas(t, []map[string]any{videoNode})}
	_, err := opCanvasGenerationPropose(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{"canvasId":"c1","nodeIds":["n1"],"kind":"image"}`))
	if err == nil {
		t.Fatal("video node must not accept image propose")
	}
	if AsError(err).Reason != "generation_kind_mismatch" {
		t.Fatalf("node kind reason: %v", err)
	}

	probe = &proposeProbe{doc: proposeCanvas(t, []map[string]any{imageNode("n1", "beefapi::wan3.0-video")})}
	probe.resolve = func(string, string) (AssistantGenerationModel, error) {
		return AssistantGenerationModel{KindMismatch: true}, nil
	}
	_, err = opCanvasGenerationPropose(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{"canvasId":"c1","nodeIds":["n1"],"kind":"image"}`))
	if err == nil {
		t.Fatal("wrong-kind model must be rejected")
	}
	if AsError(err).Reason != "generation_model_kind_mismatch" {
		t.Fatalf("model kind reason: %v", err)
	}
}
