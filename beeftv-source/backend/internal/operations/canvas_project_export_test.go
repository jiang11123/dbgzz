package operations

import (
	"context"
	"encoding/json"
	"testing"

	"infinite-canvas/backend/internal/model"
)

type projectExportDomain struct {
	timelineDomain
	exports int
}

func (d *projectExportDomain) ExportCanvasProjectArchive(_ context.Context, user, id string, raw json.RawMessage) (*model.Resource, error) {
	d.exports++
	return &model.Resource{ID: "archive", UserID: user, Status: model.ResourceStatusReady, MimeType: "application/zip", Size: 100}, nil
}

func TestCanvasProjectExportRevisionAndPortableReceipt(t *testing.T) {
	d := &projectExportDomain{timelineDomain: timelineDomain{doc: json.RawMessage(`{"id":"canvas","revision":4,"title":"雨夜/书店"}`)}}
	ctx := &Context{Context: context.Background(), UserID: "owner", OperationID: "stable", Domain: d}
	if _, err := opCanvasProjectExport(ctx, json.RawMessage(`{"canvasId":"canvas","expectedRevision":3}`)); err == nil || d.exports != 0 {
		t.Fatal("exported stale snapshot")
	}
	result, err := opCanvasProjectExport(ctx, json.RawMessage(`{"canvasId":"canvas","expectedRevision":4}`))
	if err != nil {
		t.Fatal(err)
	}
	value := result.(map[string]any)
	if value["resourceId"] != "archive" || value["fileName"] != "雨夜_书店.zip" || value["sourceRevision"] != int64(4) || value["editable"] != true {
		t.Fatalf("bad receipt %+v", value)
	}
	r := NewRegistry(nil, nil)
	registerCanvasProjectExportOps(r)
	desc, ok := r.Descriptor("canvas.project.export")
	if !ok || desc.ReadOnly || desc.Replay != "safe" || desc.Scope != ScopeCanvas {
		t.Fatalf("bad descriptor %+v", desc)
	}
}
