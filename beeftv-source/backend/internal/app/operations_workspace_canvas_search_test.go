package app

import (
	"encoding/json"
	"infinite-canvas/backend/internal/agentops"
	"infinite-canvas/backend/internal/canvas"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/operations"
	"testing"
)

func TestWorkspaceCanvasSearchKeepsLegacyProjectFilterAndOwnedScope(t *testing.T) {
	svc, db := newProjectAssetLinkTestService(t)
	if err := db.AutoMigrate(&model.CanvasProject{}); err != nil {
		t.Fatal(err)
	}
	for _, row := range []model.CanvasProject{
		{ID: "current", UserID: "owner", Title: "Untitled", PayloadJSON: `{"nodes":[]}`},
		{ID: "second", UserID: "owner", Title: "Untitled", PayloadJSON: `{"nodes":[]}`},
		{ID: "foreign", UserID: "other", Title: "Untitled", PayloadJSON: `{"nodes":[]}`},
	} {
		if err := db.Create(&row).Error; err != nil {
			t.Fatal(err)
		}
	}
	registry := operations.NewRegistry(svc, operations.NewStore(db))
	operations.RegisterDefaultOps(registry)
	run := func(mode, op string, params any) (operations.Result, error) {
		raw, _ := json.Marshal(params)
		return registry.Execute(operations.Request{UserID: "owner", Op: op, Params: raw, Caller: operations.AssistantCaller(&agentops.AssistantScope{PermissionMode: mode, CanvasID: "current"}, false)})
	}
	search := func(params any) canvas.CanvasLibraryPage {
		t.Helper()
		result, err := run("full-access", "canvas.search", params)
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(result.Result)
		var page canvas.CanvasLibraryPage
		if err := json.Unmarshal(raw, &page); err != nil {
			t.Fatal(err)
		}
		return page
	}
	page := search(map[string]any{})
	if page.Total != 2 || len(page.Projects) != 2 {
		t.Fatalf("standalone canvases hidden: %+v", page)
	}
	for _, row := range page.Projects {
		if row.ID != "current" && row.ID != "second" {
			t.Fatalf("foreign leak: %+v", row)
		}
	}
	// Public legacy canvasId is an explicit PROJECT filter, preserved for MCP/CLI.
	if page := search(map[string]any{"canvasId": "current"}); page.Total != 0 {
		t.Fatalf("unexpected legacy project behavior: %+v", page)
	}
	for _, row := range []model.CanvasProject{
		{ID: "in-project", UserID: "owner", ProjectID: "project-1", Title: "Project", PayloadJSON: `{"nodes":[]}`},
		{ID: "foreign-project", UserID: "other", ProjectID: "project-1", Title: "Secret", PayloadJSON: `{"nodes":[]}`},
	} {
		if err := db.Create(&row).Error; err != nil {
			t.Fatal(err)
		}
	}
	filtered := search(map[string]any{"canvasId": "project-1"})
	if filtered.Total != 1 || filtered.Projects[0].ID != "in-project" {
		t.Fatalf("project owner filter: %+v", filtered)
	}
	if _, err := run("canvas", "canvas.search", map[string]any{}); err == nil {
		t.Fatal("canvas-only scope expanded to workspace")
	}
	if _, err := run("full-access", "canvas.get", map[string]any{"canvasId": "foreign"}); err == nil {
		t.Fatal("foreign canvas became readable")
	}
	if _, err := run("full-access", "project.canvas.search", map[string]any{"canvasId": "foreign"}); err == nil {
		t.Fatal("foreign project search became readable")
	}
	if _, err := run("canvas", "project.canvas.search", map[string]any{"canvasId": "second"}); err == nil {
		t.Fatal("project search escaped current canvas")
	}
	if _, err := run("read-only", "canvas.node.move", map[string]any{"canvasId": "current", "nodeId": "n", "expectedRevision": 0, "position": map[string]any{"x": 0, "y": 0}}); err == nil {
		t.Fatal("readonly search enabled writes")
	}
}
