package canvas

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
)

func TestUpsertUserAssetRejectsResourceSwapWhenCanvasReferencesIt(t *testing.T) {
	svc := newCanvasHistoryTestService(t)
	now := time.Now().UTC()
	for _, id := range []string{"resource-old", "resource-new"} {
		resource := model.Resource{ID: id, UserID: "owner", Status: model.ResourceStatusReady, Provider: "local", ObjectKey: "users/owner/image/" + id + ".png", CreatedAt: now, UpdatedAt: now}
		if err := svc.repo.CreateResource(&resource); err != nil {
			t.Fatal(err)
		}
	}
	oldAsset := json.RawMessage(`{"id":"shared-asset","kind":"image","title":"旧素材","coverUrl":"/api/resources/resource-old/file","tags":[],"status":"confirmed","source":"生成任务","data":{"dataUrl":"/api/resources/resource-old/file","storageKey":"resource:resource-old","width":1,"height":1,"bytes":1,"mimeType":"image/png"}}`)
	if _, err := svc.UpsertUserAsset("owner", oldAsset); err != nil {
		t.Fatal(err)
	}
	canvas := json.RawMessage(`{"id":"canvas","revision":0,"title":"引用","nodes":[{"id":"node","type":"image","metadata":{"assetId":"shared-asset","storageKey":"resource:resource-old"}}],"connections":[]}`)
	if _, err := svc.UpsertUserCanvasProject("owner", canvas); err != nil {
		t.Fatal(err)
	}
	replacement := json.RawMessage(`{"id":"shared-asset","kind":"image","title":"新素材","coverUrl":"/api/resources/resource-new/file","tags":[],"status":"confirmed","source":"生成任务","data":{"dataUrl":"/api/resources/resource-new/file","storageKey":"resource:resource-new","width":1,"height":1,"bytes":1,"mimeType":"image/png"}}`)
	if _, err := svc.UpsertUserAsset("owner", replacement); err == nil {
		t.Fatal("resource swap succeeded while canvas still referenced the old bytes")
	}
	persisted, err := svc.UserAsset("owner", "shared-asset")
	if err != nil {
		t.Fatal(err)
	}
	if !containsJSONText(persisted, "resource:resource-old") || containsJSONText(persisted, "resource:resource-new") {
		t.Fatalf("canvas now points at different asset bytes: %s", persisted)
	}
}

func containsJSONText(raw json.RawMessage, text string) bool {
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return false
	}
	encoded, _ := json.Marshal(value)
	return string(encoded) != "" && strings.Contains(string(encoded), text)
}
