package canvas

import (
	"encoding/json"
	"math"
	"testing"
)

func TestStoryboardDurationAllWriteRoutes(t *testing.T) {
	for _, seconds := range []float64{-1, 0, 0.5, 61, math.Inf(1), math.NaN()} {
		if err := requireStoryboardRows([]StoryboardRowDraft{{DurationSeconds: &seconds}}); err == nil {
			t.Fatalf("append accepts %v", seconds)
		}
		if err := requireStoryboardPatches([]StoryboardRowPatch{{RowID: "row", StoryboardRowDraft: StoryboardRowDraft{DurationSeconds: &seconds}}}); err == nil {
			t.Fatalf("update accepts %v", seconds)
		}
	}
	for _, seconds := range []float64{1, 6, 60} {
		if err := validateStoryboardDraft(StoryboardRowDraft{DurationSeconds: &seconds}); err != nil {
			t.Fatal(err)
		}
	}
	svc, id, _, revision := storyboardFixture(t)
	user := "owner"
	for _, seconds := range []float64{-1, 0, 61} {
		doc, _ := json.Marshal(map[string]any{"nodes": []any{map[string]any{"id": "script", "type": "script", "metadata": map[string]any{"storyboard": map[string]any{"rows": []any{map[string]any{"id": "row", "durationSeconds": seconds}}}}}}})
		if _, _, err := svc.CommitUserCanvasDocument(user, id, revision, doc); err == nil {
			t.Fatalf("UI document commit accepts %v", seconds)
		}
	}
}

func TestStoryboardLegacyRowDoesNotBlockUnrelatedEdits(t *testing.T) {
	before := json.RawMessage(`{"nodes":[{"id":"script","type":"script","metadata":{"storyboard":{"rows":[{"id":"old","durationSeconds":-1},{"id":"valid","durationSeconds":6,"dialogue":"before"}]}}}]}`)
	after := json.RawMessage(`{"nodes":[{"id":"script","type":"script","metadata":{"storyboard":{"rows":[{"id":"old","durationSeconds":-1},{"id":"valid","durationSeconds":6,"dialogue":"after"}]}}}]}`)
	if _, err := reconcileStoryboardDocument(before, after); err != nil {
		t.Fatal(err)
	}
}

func TestStoryboardDocumentRejectsDuplicatedUnchangedRow(t *testing.T) {
	before := json.RawMessage(`{"nodes":[{"id":"script","type":"script","metadata":{"storyboard":{"rows":[{"id":"old","durationSeconds":6}]}}}]}`)
	after := json.RawMessage(`{"nodes":[{"id":"script","type":"script","metadata":{"storyboard":{"rows":[{"id":"old","durationSeconds":6},{"id":"old","durationSeconds":6}]}}}]}`)
	if _, err := reconcileStoryboardDocument(before, after); err == nil {
		t.Fatal("duplicated unchanged row bypassed identity validation")
	}
}

func TestDocumentCommitSharesStoryboardPromptAndRemovalRules(t *testing.T) {
	svc, id, _, revision := storyboardFixture(t)
	user := "owner"
	before := json.RawMessage(`{"nodes":[{"id":"script","type":"script","metadata":{"storyboard":{"rows":[{"id":"one","shotNumber":1,"durationSeconds":6,"imageGenerationPrompt":"old","imagePromptTemplateVariables":{"keep":false}},{"id":"two","shotNumber":2,"durationSeconds":6,"videoMotionPrompt":"same","videoPromptTemplateVariables":{"keep":true}}]}}}],"connections":[{"id":"removed","fromNodeId":"script","toNodeId":"txt","fromHandleId":"row:one"},{"id":"kept","fromNodeId":"script","toNodeId":"txt","storyboardRowId":"two"}]}`)
	saved, _, err := svc.CommitUserCanvasDocument(user, id, revision, before)
	if err != nil {
		t.Fatal(err)
	}
	// Simulate a UI snapshot that forgot both template invalidation and edge cleanup.
	after := json.RawMessage(`{"nodes":[{"id":"script","type":"script","metadata":{"storyboard":{"rows":[{"id":"two","shotNumber":2,"durationSeconds":6,"videoMotionPrompt":"changed","videoPromptTemplateVariables":{"keep":true}}]}}}],"connections":[{"id":"removed","fromNodeId":"script","toNodeId":"txt","fromHandleId":"row:one"},{"id":"kept","fromNodeId":"script","toNodeId":"txt","storyboardRowId":"two"}]}`)
	if _, _, err := svc.CommitUserCanvasDocument(user, id, saved.Revision, after); err == nil {
		t.Fatal("invalid UI snapshot accepted")
	}
	// Existing UI clears stale templates and edges before its document commit.
	after = json.RawMessage(`{"nodes":[{"id":"script","type":"script","metadata":{"storyboard":{"rows":[{"id":"two","shotNumber":1,"durationSeconds":6,"videoMotionPrompt":"changed"}]}}}],"connections":[{"id":"kept","fromNodeId":"script","toNodeId":"txt","storyboardRowId":"two"}]}`)
	_, raw, err := svc.CommitUserCanvasDocument(user, id, saved.Revision, after)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	row := storyboardDocumentRows(findCanvasNode(doc, "script"))[0].(map[string]any)
	if _, ok := row["videoPromptTemplateVariables"]; ok {
		t.Fatal("manual prompt kept stale template")
	}
	if row["shotNumber"] != float64(1) {
		t.Fatal("remaining shot not renumbered")
	}
	edges := doc["connections"].([]any)
	if len(edges) != 1 || edges[0].(map[string]any)["id"] != "kept" {
		t.Fatalf("edges: %#v", edges)
	}
}
