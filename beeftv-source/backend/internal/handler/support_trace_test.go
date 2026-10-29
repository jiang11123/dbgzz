package handler

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func TestSupportHTTPTracePersistsW3CParentAndSkipsPollingAndExport(t *testing.T) {
	h := newRetiredAgentHarness(t)
	defer h.svc.Close()
	r := gin.New()
	r.Use(RequestCorrelationMiddleware(), SupportTracingMiddleware(h.svc))
	r.POST("/api/tasks/:id", func(c *gin.Context) { c.Status(http.StatusConflict) })
	r.GET("/api/tasks/:id", func(c *gin.Context) { c.Status(http.StatusOK) })
	r.POST("/api/diagnostics/export", func(c *gin.Context) { c.Status(http.StatusOK) })
	const traceID = "11223344556677889900aabbccddeeff"
	for _, route := range []struct{ method, path string }{{"POST", "/api/tasks/task-1"}, {"GET", "/api/tasks/task-1"}, {"POST", "/api/diagnostics/export"}} {
		request := httptest.NewRequest(route.method, route.path, nil)
		request.Header.Set("traceparent", "00-"+traceID+"-1122334455667788-01")
		request.Header.Set("X-Canvas-Trace-ID", "legacy-conflicting-trace")
		response := httptest.NewRecorder()
		r.ServeHTTP(response, request)
		if response.Header().Get(traceIDHeader) != traceID {
			t.Fatal("W3C correlation lost")
		}
	}
	owner, err := h.svc.LocalWorkspaceOwner()
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := h.svc.SupportTrace().Snapshot(owner.ID, time.Now().Add(-time.Minute), time.Now().Add(time.Minute))
	if err != nil || len(snapshot.Events) != 2 {
		t.Fatalf("unexpected records: %+v %v", snapshot, err)
	}
	for _, event := range snapshot.Events {
		if event.TraceID != traceID || event.TaskID != "task-1" || event.RequestID == "" {
			t.Fatalf("lost correlation: %+v", event)
		}
		if event.Phase == "start" && event.ParentSpanID != "1122334455667788" {
			t.Fatal("parent lost")
		}
		if event.Phase == "end" && (event.Reason != "http_409" || event.Status != "error") {
			t.Fatal("failure lost")
		}
	}
}
