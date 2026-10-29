package canvas

import (
	"encoding/json"
	"errors"
	"net/http"
	"testing"

	"infinite-canvas/backend/internal/kernel"
)

func TestCommitUserCanvasDocumentPreservesUntouchedFieldsAndCAS(t *testing.T) {
	svc := newCanvasHistoryTestService(t)
	created, err := svc.UpsertUserCanvasProject("owner", json.RawMessage(`{
		"id":"canvas","revision":0,"title":"initial",
		"nodes":[{"id":"n1","type":"text","title":"旧"}],
		"connections":[],
		"customKeep":"keep-me",
		"viewport":{"x":9,"y":8,"k":2}
	}`))
	if err != nil {
		t.Fatal(err)
	}
	overlay := json.RawMessage(`{
		"id":"forged","revision":99,"remoteContentHash":"local-only",
		"title":"手工提交",
		"nodes":[{"id":"n1","type":"text","title":"新"}],
		"viewport":{"x":1,"y":1,"k":4}
	}`)
	summary, after, err := svc.CommitUserCanvasDocument("owner", "canvas", created.Revision, overlay)
	if err != nil {
		t.Fatal(err)
	}
	if summary.Revision != created.Revision+1 {
		t.Fatalf("revision = %d", summary.Revision)
	}
	var doc map[string]any
	if err := json.Unmarshal(after, &doc); err != nil {
		t.Fatal(err)
	}
	if doc["id"] != "canvas" || doc["title"] != "手工提交" || doc["customKeep"] != "keep-me" {
		t.Fatalf("合并丢字段: %s", after)
	}
	if doc["remoteContentHash"] != nil {
		t.Fatal("不应写入 remoteContentHash")
	}
	viewport := doc["viewport"].(map[string]any)
	if viewport["x"] != float64(0) {
		t.Fatalf("视口应由服务端保留: %s", after)
	}
	_, _, err = svc.CommitUserCanvasDocument("owner", "canvas", created.Revision, overlay)
	var appErr *kernel.AppError
	if !errors.As(err, &appErr) || appErr.Status != http.StatusConflict {
		t.Fatalf("过期 revision 必须冲突: %v", err)
	}
	_, _, err = svc.CommitUserCanvasDocument("owner", "missing", summary.Revision, overlay)
	if !errors.As(err, &appErr) || appErr.Status != http.StatusNotFound {
		t.Fatalf("缺失画布必须 404: %v", err)
	}
}
