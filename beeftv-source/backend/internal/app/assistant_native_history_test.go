package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"infinite-canvas/backend/internal/agentops"
	"infinite-canvas/backend/internal/assistantturns"
	"infinite-canvas/backend/internal/editing"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/operations"
	"infinite-canvas/backend/internal/repository"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestNativeHistoryAudioKeepsExactSessionPinAcrossCanvasPermission(t *testing.T) {
	svc, canvasID, _ := newAssistantTurnService(t)
	ffmpeg, err := editing.ResolveFFmpegBinary()
	if err != nil {
		t.Fatal(err)
	}
	f := filepath.Join(t.TempDir(), "voice.wav")
	if out, err := exec.Command(ffmpeg, "-nostdin", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.1", "-c:a", "pcm_s16le", f).CombinedOutput(); err != nil {
		t.Fatalf("%v %s", err, out)
	}
	b, err := os.ReadFile(f)
	if err != nil {
		t.Fatal(err)
	}
	makeAsset := func(id string) string {
		resource, err := svc.UploadResourceFile("local", id+".wav", int64(len(b)), "audio", 0, 0, 100, bytes.NewReader(b))
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(map[string]any{"id": id, "title": id, "kind": "audio", "coverUrl": "", "tags": []string{}, "data": map[string]any{"storageKey": "resource:" + resource.ID, "bytes": resource.Size, "mimeType": resource.MimeType, "durationMs": 100}})
		if _, err := svc.UpsertUserAsset("local", raw); err != nil {
			t.Fatal(err)
		}
		return resource.ID
	}
	rid := makeAsset("historic-audio")
	otherID := makeAsset("not-read-audio")
	hash := sha256.Sum256(b)
	source := operations.MediaSource{CanvasID: canvasID, AssetID: "historic-audio", ResourceID: rid, Version: hex.EncodeToString(hash[:]), StartMs: 0, EndMs: 100}
	rawDoc, _ := svc.UserCanvasProject("local", canvasID)
	var doc map[string]any
	json.Unmarshal(rawDoc, &doc)
	doc["nodes"] = append(doc["nodes"].([]any), map[string]any{"id": "history-audio-node", "type": "audio", "title": "voice", "position": map[string]any{"x": 1, "y": 1}, "metadata": map[string]any{"assetId": "historic-audio", "storageKey": "resource:" + rid, "content": "/api/resources/" + rid + "/file"}})
	saveDoc := func() {
		doc["revision"] = canvasRevisionOf(t, svc, canvasID)
		raw, _ := json.Marshal(doc)
		if _, err := svc.UpsertUserCanvasProject("local", raw); err != nil {
			t.Fatal(err)
		}
	}
	saveDoc()
	nodeSource := source
	nodeSource.AssetID = ""
	nodeSource.NodeID = "history-audio-node"
	const origin = "aaaaaaaaaaaaaaaa"
	const current = "bbbbbbbbbbbbbbbb"
	const session = "durable:11111111-1111-1111-1111-111111111111"
	if _, err := svc.BeginAssistantTurn("local", canvasID, origin, AssistantTurnInput{PermissionMode: assistantturns.PermissionFullAccess, AssetIDs: []string{"historic-audio"}}); err != nil {
		t.Fatal(err)
	}
	if err := svc.BindAssistantDurableSession("local", origin, session, false); err != nil {
		t.Fatal(err)
	}
	if err := svc.RegisterAssistantNativeSource(context.Background(), "local", origin, origin, session, source); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.RevalidateAssistantNativeSource(context.Background(), "local", origin, origin, session, source); err != nil {
		t.Fatal(err)
	}
	if err := svc.RegisterAssistantNativeSource(context.Background(), "local", origin, origin, session, nodeSource); err != nil {
		t.Fatal(err)
	}
	if err := svc.FinalizeAssistantTurn(origin); err != nil {
		t.Fatal(err)
	}
	doc["nodes"].([]any)[1].(map[string]any)["metadata"] = map[string]any{"assetId": "not-read-audio", "storageKey": "resource:" + otherID, "content": "/api/resources/" + otherID + "/file"}
	saveDoc()
	if _, err := svc.BeginAssistantTurn("local", canvasID, current, AssistantTurnInput{PermissionMode: assistantturns.PermissionCanvas}); err != nil {
		t.Fatal(err)
	}
	if err := svc.BindAssistantDurableSession("local", current, session, false); err != nil {
		t.Fatal(err)
	}
	scope, ok, err := svc.AssistantTurnScopeForHost("local", current)
	if err != nil || !ok {
		t.Fatalf("%v %v", ok, err)
	}
	sc := &agentops.AssistantScope{CanvasID: scope.CanvasID, PermissionMode: scope.PermissionMode}
	raw, _ := json.Marshal(map[string]any{"canvasId": canvasID, "assetId": "historic-audio"})
	if sc.Allows(&operations.Op{ID: "media.overview", ReadOnly: true}, raw) == nil {
		t.Fatal("history widened current tools")
	}
	if _, err := svc.RevalidateAssistantNativeSource(context.Background(), "local", current, origin, session, source); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.RevalidateAssistantNativeSource(context.Background(), "local", current, origin, session, nodeSource); err != nil {
		t.Fatalf("old node output should survive new node content: %v", err)
	}
	if err := svc.RegisterAssistantNativeSource(context.Background(), "local", current, origin, session, nodeSource); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name, user, session string
		source              operations.MediaSource
	}{{"other-owner", "other", session, source}, {"foreign-session", "local", "durable:22222222-2222-2222-2222-222222222222", source}, {"full-origin-not-read", "local", session, operations.MediaSource{CanvasID: canvasID, AssetID: "not-read-audio", ResourceID: otherID, Version: source.Version, StartMs: 0, EndMs: 100}}, {"changed-version", "local", session, operations.MediaSource{CanvasID: canvasID, AssetID: source.AssetID, ResourceID: rid, Version: "wrong", StartMs: 0, EndMs: 100}}} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := svc.RevalidateAssistantNativeSource(context.Background(), test.user, current, origin, test.session, test.source); err == nil {
				t.Fatal("unauthorized native history accepted")
			}
		})
	}
	if err := svc.BindAssistantDurableSession("local", origin, "durable:22222222-2222-2222-2222-222222222222", true); err == nil {
		t.Fatal("historical session moved")
	}
	if err := svc.FinalizeAssistantTurn(current); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.RevalidateAssistantNativeSource(context.Background(), "local", current, origin, session, source); err == nil {
		t.Fatal("closed current turn allowed dispatch")
	}
}

// Store boundary test: the host has already verified each opaque source pin.
// This checks persistence/cap policy, not additional media-understanding proof.
func TestNativeHistoryPinCapDedupAndDatabaseReopen(t *testing.T) {
	svc, canvasID, _ := newAssistantTurnService(t)
	const turn = "cccccccccccccccc"
	const session = "durable:33333333-3333-3333-3333-333333333333"
	if _, err := svc.BeginAssistantTurn("local", canvasID, turn, AssistantTurnInput{}); err != nil {
		t.Fatal(err)
	}
	if err := svc.BindAssistantDurableSession("local", turn, session, false); err != nil {
		t.Fatal(err)
	}
	store := svc.assistantTurnsOrInit()
	for i := 0; i < 128; i++ {
		if err := store.RegisterNativeSource("local", turn, session, fmt.Sprintf("verified-pin-%03d", i)); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.RegisterNativeSource("local", turn, session, "verified-pin-000"); err != nil {
		t.Fatal("duplicate rejected at cap", err)
	}
	if err := store.RegisterNativeSource("local", turn, session, "verified-pin-129"); err == nil {
		t.Fatal("129th pin accepted")
	}
	db := svc.Database()
	file := db.Dialector.(*sqlite.Dialector).DSN
	sql, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	if err := sql.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := gorm.Open(sqlite.Open(file), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	newSQL, _ := reopened.DB()
	defer newSQL.Close()
	fresh := NewLocal(repository.New(reopened), svc.dataDir)
	var row model.AssistantTurn
	if err := reopened.First(&row, "turn_id = ?", turn).Error; err != nil {
		t.Fatal(err)
	}
	var pins []string
	if json.Unmarshal([]byte(row.DurableNativeSources), &pins) != nil || len(pins) != 128 {
		t.Fatalf("persisted cap changed: %d", len(pins))
	}
	if !fresh.assistantTurnsOrInit().HasNativeSource("local", turn, session, "verified-pin-000") {
		t.Fatal("pin lost after database reopen")
	}
	if err := fresh.BindAssistantDurableSession("local", turn, "durable:44444444-4444-4444-4444-444444444444", false); err == nil {
		t.Fatal("session changed after reopen")
	}
}
