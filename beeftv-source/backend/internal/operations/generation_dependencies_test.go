package operations

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestGenerationProposalDependencies(t *testing.T) {
	for _, tc := range []struct {
		name        string
		refMetadata map[string]any
		targets     []string
		wantBlocked bool
	}{
		{"same batch empty reference", nil, []string{"ref", "shot"}, true},
		{"external empty reference", nil, []string{"shot"}, true},
		{"ready reference", map[string]any{"storageKey": "local/ready.png"}, []string{"shot"}, false},
		{"old reference regenerated in same batch", map[string]any{"content": "old-result"}, []string{"ref", "shot"}, true},
		{"old reference still running", map[string]any{"content": "old-result", "taskStatus": "running"}, []string{"shot"}, true},
		{"old reference queued", map[string]any{"content": "old-result", "taskStatus": "queued"}, []string{"shot"}, true},
		{"old reference submitting", map[string]any{"content": "old-result", "generationSubmissionState": "submitting"}, []string{"shot"}, true},
		{"old reference unknown submission", map[string]any{"content": "old-result", "generationSubmissionState": "unknown"}, []string{"shot"}, true},
		{"old reference awaiting delivered result", map[string]any{"content": "old-result", "taskStatus": "succeeded", "resourceReloadAvailable": true}, []string{"shot"}, true},
		{"old reference missing new result", map[string]any{"content": "old-result", "taskStatus": "succeeded", "generationErrorCode": "results_missing"}, []string{"shot"}, true},
		{"completed reference", map[string]any{"content": "new-result", "generationSubmissionState": "accepted", "taskStatus": "succeeded"}, []string{"shot"}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ref := imageNode("ref", "")
			ref["metadata"] = tc.refMetadata
			probe := dependencyProbe(t, []map[string]any{ref, imageNode("shot", "")}, [][2]string{{"ref", "shot"}})
			params, _ := json.Marshal(map[string]any{"canvasId": "c1", "kind": "image", "nodeIds": tc.targets})
			result, err := opCanvasGenerationPropose(&Context{UserID: "owner", Domain: probe}, params)
			if !tc.wantBlocked {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			if err == nil || result != nil {
				t.Fatalf("unsafe proposal returned: result=%v err=%v", result, err)
			}
			opErr := AsError(err)
			if opErr.Reason != "generation_dependencies_not_ready" || opErr.Code != CodePreconditionFailed || !reflect.DeepEqual(opErr.Details["unreadyNodeIds"], []string{"ref"}) || !reflect.DeepEqual(opErr.Details["blockedNodeIds"], []string{"shot"}) {
				t.Fatalf("dependency error must identify prerequisites and blocked targets: %#v", opErr)
			}
		})
	}
}

func dependencyProbe(t *testing.T, nodes []map[string]any, edges [][2]string) *proposeProbe {
	t.Helper()
	connections := make([]map[string]any, 0, len(edges))
	for _, edge := range edges {
		connections = append(connections, map[string]any{"fromNodeId": edge[0], "toNodeId": edge[1]})
	}
	raw, err := json.Marshal(map[string]any{"id": "c1", "revision": 4, "nodes": nodes, "connections": connections})
	if err != nil {
		t.Fatal(err)
	}
	return &proposeProbe{doc: raw}
}

func TestGenerationDependencyReferenceSelection(t *testing.T) {
	for _, tc := range []struct {
		name        string
		kind        string
		prompt      string
		frame       string
		extra       []map[string]any
		edges       [][2]string
		wantBlocked bool
	}{
		{name: "script output is text context", extra: []map[string]any{{"id": "script", "type": "script"}}, edges: [][2]string{{"script", "shot"}}},
		{name: "unrelated empty media", edges: nil},
		{name: "ready media history is not a live dependency", edges: [][2]string{{"empty", "ready"}, {"ready", "shot"}}},
		{name: "config reference must finish", extra: []map[string]any{{"id": "config", "type": "config"}}, edges: [][2]string{{"shot", "config"}, {"empty", "config"}}, wantBlocked: true},
		{name: "config inputs take precedence", extra: []map[string]any{{"id": "config", "type": "config"}}, edges: [][2]string{{"shot", "config"}, {"ready", "config"}, {"empty", "shot"}}},
		{name: "explicit ready node selects subset", prompt: "use @[node:ready]", edges: [][2]string{{"empty", "shot"}, {"ready", "shot"}}},
		{name: "numbered reference skips empty placeholder", prompt: "use @图片1", edges: [][2]string{{"empty", "shot"}, {"ready", "shot"}}},
		{name: "numbered token needs boundary", prompt: "use @图片1suffix", edges: [][2]string{{"empty", "shot"}, {"ready", "shot"}}, wantBlocked: true},
		{name: "explicit empty node is not silently skipped", prompt: "use @[node:empty]", edges: [][2]string{{"empty", "shot"}}, wantBlocked: true},
		{name: "explicit text omits image reference", prompt: "use @文本1", extra: []map[string]any{{"id": "text", "type": "text", "metadata": map[string]any{"content": "instructions"}}}, edges: [][2]string{{"text", "shot"}, {"empty", "shot"}}},
		{name: "video uses all connected media", kind: "video", prompt: "use @[node:ready]", edges: [][2]string{{"empty", "shot"}, {"ready", "shot"}}, wantBlocked: true},
		{name: "structured frame still required", kind: "video", frame: "empty", prompt: "use @[node:ready]", edges: [][2]string{{"ready", "shot"}}, wantBlocked: true},
		{name: "deleted structured frame", kind: "video", frame: "deleted", wantBlocked: true},
		{name: "ready self edit", prompt: "use @[node:shot]"},
		{name: "character asset is hydrated elsewhere", extra: []map[string]any{{"id": "character", "type": "image", "metadata": map[string]any{"workflowKind": "character", "characterAssetId": "asset-1"}}}, edges: [][2]string{{"character", "shot"}}},
		{name: "pending conversion", extra: []map[string]any{{"id": "convert", "type": "media-conversion", "metadata": map[string]any{"mediaConversion": map[string]any{"status": "processing"}}}}, edges: [][2]string{{"convert", "shot"}}, wantBlocked: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			kind := tc.kind
			if kind == "" {
				kind = "image"
			}
			shot := imageNode("shot", "")
			shot["type"] = kind
			shot["metadata"] = map[string]any{"composerContent": tc.prompt, "content": "old-shot", "videoStartFrameNodeId": tc.frame}
			ready := imageNode("ready", "")
			ready["metadata"] = map[string]any{"storageKey": "local/ready.png"}
			probe := dependencyProbe(t, append([]map[string]any{shot, ready, imageNode("empty", "")}, tc.extra...), tc.edges)
			params, _ := json.Marshal(map[string]any{"canvasId": "c1", "kind": kind, "nodeIds": []string{"shot"}})
			_, err := opCanvasGenerationPropose(&Context{UserID: "owner", Domain: probe}, params)
			if tc.wantBlocked != (err != nil) {
				t.Fatalf("want blocked=%t, got %v", tc.wantBlocked, err)
			}
			if err != nil && AsError(err).Reason != "generation_dependencies_not_ready" {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}

func TestGenerationDependencyNodeMentionUsesNormalizedBoundary(t *testing.T) {
	for _, tc := range []struct {
		prompt  string
		blocked bool
	}{
		{"@[node:ready] next", false},
		{"@[node:ready]，旁边", false},
		{"@[node:ready]旁边", true},
		{"@[node:ready]suffix", true},
		{"@图片1\u3000next", false},
		{"@图片1\u00a0next", false},
		{"@图片1\vnext", false},
		{"@图片1\ufeffnext", false},
		{"@图片1\u0085next", true},
	} {
		t.Run(tc.prompt, func(t *testing.T) {
			ready := imageNode("ready", "")
			ready["metadata"] = map[string]any{"content": "ready-image"}
			pending := imageNode("pending", "")
			pending["metadata"] = map[string]any{"content": "old-image", "status": "loading", "taskStatus": "running"}
			shot := imageNode("shot", "")
			shot["metadata"] = map[string]any{"composerContent": tc.prompt}
			probe := dependencyProbe(t, []map[string]any{ready, pending, shot}, [][2]string{{"ready", "shot"}, {"pending", "shot"}})
			result, err := opCanvasGenerationPropose(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{"canvasId":"c1","kind":"image","nodeIds":["shot"]}`))
			if !tc.blocked {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			if result != nil || err == nil {
				t.Fatalf("normalized mention falls back to all inputs; pending media must block: result=%v err=%v", result, err)
			}
			opErr := AsError(err)
			if opErr.Reason != "generation_dependencies_not_ready" || !reflect.DeepEqual(opErr.Details["unreadyNodeIds"], []string{"pending"}) {
				t.Fatalf("wrong rejection: %#v", opErr)
			}
		})
	}
}
