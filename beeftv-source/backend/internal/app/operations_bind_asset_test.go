package app

import (
	"bytes"
	"encoding/json"
	"errors"
	"image"
	"image/png"
	"infinite-canvas/backend/internal/agentops"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/operations"
	"testing"
)

func TestBindAssetProjectAuthorizationDoesNotHoldSQLiteConnection(t *testing.T) {
	svc, canvasID, _ := newAssistantTurnService(t)
	db := svc.repo.DB()
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	// Match the desktop connection pool. A project resolver uses the service's
	// normal connection and must not be called inside a write transaction.
	sqlDB.SetMaxOpenConns(1)
	for _, row := range []any{
		&model.Project{ID: "p1", UserID: "local", Name: "Binding", Status: model.ProjectStatusActive},
		&model.Resource{ID: "reference-resource", UserID: "local", Kind: "image", MimeType: "image/png", Status: model.ResourceStatusReady},
		&model.Asset{ID: "linked", UserID: "local", Kind: "image", PayloadJSON: `{"resourceId":"reference-resource"}`},
		&model.ProjectAssetLink{ID: "link", ProjectID: "p1", AssetID: "linked"},
	} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	raw, _ := json.Marshal(map[string]any{"id": canvasID, "title": "Binding", "revision": canvasRevisionOf(t, svc, canvasID), "nodes": []any{
		map[string]any{"id": "reference", "type": "image", "metadata": map[string]any{}},
	}, "connections": []any{}})
	if _, err := svc.UpsertUserCanvasProject("local", raw); err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.CanvasProject{}).Where("id = ?", canvasID).Update("project_id", "p1").Error; err != nil {
		t.Fatal(err)
	}
	calledInsideTransaction := false
	scope := &agentops.AssistantScope{CanvasID: canvasID, ProjectReference: func(kind, id string) error {
		if sqlDB.Stats().InUse != 0 {
			calledInsideTransaction = true
			// Detect the native deadlock without leaving a blocked goroutine.
			return errors.New("project authorization holds the only SQLite connection")
		}
		return svc.ValidateAgentProjectReference("local", canvasID, kind, id)
	}}
	registry := operations.NewRegistry(svc, operations.NewStore(db))
	operations.RegisterDefaultOps(registry)
	revision := canvasRevisionOf(t, svc, canvasID)
	run := func(assetID, opID string) (operations.Result, error) {
		params, _ := json.Marshal(map[string]any{"canvasId": canvasID, "nodeId": "reference",
			"assetId": assetID, "expectedRevision": revision})
		return registry.Execute(operations.Request{UserID: "local", Op: "canvas.node.bind_asset",
			OpID: opID, Params: params, Caller: operations.AssistantCaller(scope, false)})
	}
	if _, err := run("unrelated", "deny-unrelated"); err == nil || operations.AsError(err).Reason != "scope_denied" {
		t.Fatalf("unrelated binding should be denied: %v", err)
	}
	if calledInsideTransaction {
		t.Fatal("project authorization ran while the write transaction held the only SQLite connection")
	}
	if canvasRevisionOf(t, svc, canvasID) != revision {
		t.Fatal("denied binding changed the canvas")
	}
	result, err := run("linked", "bind-project-reference")
	if err != nil || result.Revision != revision+1 {
		t.Fatalf("linked project asset did not bind: %+v %v", result, err)
	}
	if err := db.Where("id = ?", "link").Delete(&model.ProjectAssetLink{}).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := run("linked", "bind-project-reference"); err == nil || operations.AsError(err).Reason != "scope_denied" {
		t.Fatalf("revocation must deny even an existing receipt: %v", err)
	}
	if calledInsideTransaction {
		t.Fatal("project authorization entered a write transaction")
	}
}

func TestBindAssetRealCanvasRegistryPermissionsReplayAndUndo(t *testing.T) {
	svc, canvasID, _ := newAssistantTurnService(t)
	var pngBytes bytes.Buffer
	png.Encode(&pngBytes, image.NewRGBA(image.Rect(0, 0, 3, 2)))
	imageResource, err := svc.UploadResourceFile("local", "reference.png", int64(pngBytes.Len()), "image", 3, 2, 0, bytes.NewReader(pngBytes.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	resources := []model.Resource{*imageResource, {ID: "ready-video", UserID: "local", Kind: "video", MimeType: "video/mp4", Status: model.ResourceStatusReady, Width: 640, Height: 360, DurationMs: 12000, Size: 100}, {ID: "ready-audio", UserID: "local", Kind: "audio", MimeType: "audio/wav", Status: model.ResourceStatusReady, DurationMs: 12000, Size: 100}}
	for i := 1; i < len(resources); i++ {
		if err := svc.repo.DB().Create(&resources[i]).Error; err != nil {
			t.Fatal(err)
		}
	}
	for _, r := range []model.Resource{{ID: "not-ready", UserID: "local", Kind: "image", MimeType: "image/png", Status: "pending"}, {ID: "foreign-resource", UserID: "other", Kind: "image", MimeType: "image/png", Status: model.ResourceStatusReady}} {
		if err := svc.repo.DB().Create(&r).Error; err != nil {
			t.Fatal(err)
		}
	}
	for _, a := range []model.Asset{{ID: "foreign-asset", UserID: "other", Kind: "image", PayloadJSON: `{"resourceId":"foreign-resource"}`}, {ID: "pending-asset", UserID: "local", Kind: "image", PayloadJSON: `{"resourceId":"not-ready"}`}, {ID: "wrong-owner-resource-asset", UserID: "local", Kind: "image", PayloadJSON: `{"resourceId":"foreign-resource"}`}, {ID: "wrong-mime-asset", UserID: "local", Kind: "image", PayloadJSON: `{"resourceId":"ready-video"}`}} {
		if err := svc.repo.DB().Create(&a).Error; err != nil {
			t.Fatal(err)
		}
	}
	nodes := []any{}
	for _, r := range resources {
		assetID := "asset-" + r.Kind
		payload, _ := json.Marshal(map[string]any{"id": assetID, "kind": r.Kind, "resourceId": r.ID, "data": map[string]any{"storageKey": "resource:" + r.ID}})
		if err := svc.repo.DB().Create(&model.Asset{ID: assetID, UserID: "local", Kind: r.Kind, PayloadJSON: string(payload)}).Error; err != nil {
			t.Fatal(err)
		}
		nodes = append(nodes, map[string]any{"id": "node-" + r.Kind, "type": r.Kind, "title": "Reference", "position": map[string]any{"x": 0, "y": 0}, "metadata": map[string]any{"content": "", "custom": "keep", "naturalWidth": 9999, "naturalHeight": 8888, "durationMs": 300000}})
	}
	doc := map[string]any{"id": canvasID, "title": "Binding", "revision": canvasRevisionOf(t, svc, canvasID), "nodes": nodes, "connections": []any{}}
	raw, _ := json.Marshal(doc)
	if _, err := svc.UpsertUserCanvasProject("local", raw); err != nil {
		t.Fatal(err)
	}
	registry := operations.NewRegistry(svc, operations.NewStore(svc.repo.DB()))
	operations.RegisterDefaultOps(registry)
	scope := &agentops.AssistantScope{CanvasID: canvasID, AssetIDs: map[string]bool{"asset-image": true, "asset-video": true, "asset-audio": true, "foreign-asset": true, "pending-asset": true, "wrong-owner-resource-asset": true, "wrong-mime-asset": true}}
	run := func(op, id, turn string, params map[string]any, caller operations.Caller) (operations.Result, error) {
		raw, _ := json.Marshal(params)
		return registry.Execute(operations.Request{Op: op, OpID: id, TurnID: turn, UserID: "local", Params: raw, Caller: caller})
	}
	revision := canvasRevisionOf(t, svc, canvasID)
	params := map[string]any{"canvasId": canvasID, "nodeId": "node-image", "assetId": "asset-image", "expectedRevision": revision}
	// Denials must neither change the canvas nor claim a write receipt.
	for _, test := range []struct {
		name  string
		patch map[string]any
		scope *agentops.AssistantScope
		ro    bool
	}{
		{"readonly", nil, scope, true}, {"unreferenced", nil, &agentops.AssistantScope{CanvasID: canvasID}, false},
		{"unknown", map[string]any{"content": "https://evil.test/image"}, scope, false},
		{"foreign-node", map[string]any{"nodeId": "missing"}, scope, false},
		{"wrong-kind", map[string]any{"nodeId": "node-video"}, scope, false},
		{"resource-mismatch", map[string]any{"resourceId": "ready-video"}, scope, false},
		{"foreign-asset", map[string]any{"assetId": "foreign-asset"}, scope, false},
		{"non-ready", map[string]any{"assetId": "pending-asset"}, scope, false},
		{"foreign-resource", map[string]any{"assetId": "wrong-owner-resource-asset"}, scope, false},
		{"mime-kind", map[string]any{"assetId": "wrong-mime-asset"}, scope, false},
		{"stale", map[string]any{"expectedRevision": revision - 1}, scope, false},
	} {
		p := map[string]any{}
		for k, v := range params {
			p[k] = v
		}
		for k, v := range test.patch {
			p[k] = v
		}
		if _, err := run("canvas.node.bind_asset", "deny-"+test.name, "", p, operations.AssistantCaller(test.scope, test.ro)); err == nil {
			t.Fatalf("accepted %s", test.name)
		} else if test.name == "unreferenced" && operations.AsError(err).Reason != "scope_denied" {
			t.Fatalf("unreferenced asset must fail secondary scope authorization: %v", err)
		}
		if got := canvasRevisionOf(t, svc, canvasID); got != revision {
			t.Fatalf("denial changed revision %s", test.name)
		}
	}
	if _, err := svc.BeginAssistantTurn("local", canvasID, "abcdef0123456789abcdef0123456789", AssistantTurnInput{}); err != nil {
		t.Fatal(err)
	}
	for _, r := range resources {
		params := map[string]any{"canvasId": canvasID, "nodeId": "node-" + r.Kind, "assetId": "asset-" + r.Kind, "expectedRevision": revision}
		result, err := run("canvas.node.bind_asset", "bind-"+r.Kind, "abcdef0123456789abcdef0123456789", params, operations.AssistantCaller(scope, false))
		if err != nil {
			t.Fatal(err)
		}
		revision = result.Revision
		replay, err := run("canvas.node.bind_asset", "bind-"+r.Kind, "abcdef0123456789abcdef0123456789", params, operations.AssistantCaller(scope, false))
		if err != nil || !replay.Replayed || canvasRevisionOf(t, svc, canvasID) != revision {
			t.Fatalf("replay=%#v %v", replay, err)
		}
	}
	saved, err := svc.UserCanvasProject("local", canvasID)
	if err != nil {
		t.Fatal(err)
	}
	var persisted struct {
		Nodes []struct {
			Type     string         `json:"type"`
			Metadata map[string]any `json:"metadata"`
		} `json:"nodes"`
	}
	if json.Unmarshal(saved, &persisted) != nil {
		t.Fatal("readback")
	}
	for _, n := range persisted.Nodes {
		m := n.Metadata
		if n.Type == "image" && (m["naturalWidth"] != float64(3) || m["naturalHeight"] != float64(2) || m["durationMs"] != nil) {
			t.Fatalf("stale image metadata: %#v", m)
		}
		if n.Type == "audio" && (m["naturalWidth"] != nil || m["naturalHeight"] != nil || m["durationMs"] != float64(12000)) {
			t.Fatalf("stale audio metadata: %#v", m)
		}
		if n.Type == "video" && (m["naturalWidth"] != float64(640) || m["naturalHeight"] != float64(360) || m["durationMs"] != float64(12000)) {
			t.Fatalf("stale video metadata: %#v", m)
		}
		if m["content"] == "" || m["storageKey"] == "" || m["assetId"] != "asset-"+n.Type || m["nodeRole"] != "result" || m["resultOrigin"] != "library" || m["custom"] != "keep" {
			t.Fatalf("not a consumable reference: %#v", m)
		}
	}
	// Close with actual receipts, then exercise real whole-turn restoration.
	if err := svc.FinalizeAssistantTurn("abcdef0123456789abcdef0123456789"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UndoAssistantTurn("local", canvasID, "abcdef0123456789abcdef0123456789"); err != nil {
		t.Fatal(err)
	}
	restored, _ := svc.UserCanvasProject("local", canvasID)
	persisted.Nodes = nil
	json.Unmarshal(restored, &persisted)
	for _, n := range persisted.Nodes {
		if n.Metadata["content"] != "" || n.Metadata["assetId"] != nil {
			t.Fatalf("undo did not restore reference draft: %#v", n.Metadata)
		}
	}
}
