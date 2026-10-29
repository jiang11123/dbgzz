package bootstrap

import (
	"bytes"
	"encoding/json"
	"image"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/agentops"
	"infinite-canvas/backend/internal/editing"
	"infinite-canvas/backend/internal/model"
)

func TestExternalBusinessRealUploadRenderAndIsolation(t *testing.T) {
	h := newDesktopHarness(t)
	owner, canvas, rev := seedOpsAcceptanceCanvas(t, h)
	reg, token, err := agentops.NewClientRegistry(h.dataDir).Register("full-business", "")
	if err != nil {
		t.Fatal(err)
	}
	if reg.Mode != agentops.ClientReadWrite {
		t.Fatal("new credential is not full access")
	}
	call := func(method, path, body string) *httptest.ResponseRecorder {
		return h.call(requestOptions{method: method, path: path, body: body, clientID: reg.ID, clientToken: token})
	}
	market := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || r.URL.Path != "/search" || r.Header.Get("Authorization") != "" {
			t.Error("public market query changed scope or received credentials", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true,"data":{"items":[],"total":0,"page":1,"pageSize":20,"target":"beeftv"}}`))
	}))
	defer market.Close()
	t.Setenv("BEEFTV_SKILLHUB_URL", market.URL)
	if response := call("GET", "/skills/market/search?q=storyboard", ""); response.Code != 200 {
		t.Fatal("public market read rejected", response.Code, response.Body.String())
	}
	listing := call("GET", "/business/tools", "")
	if listing.Code != 200 {
		t.Fatal(listing.Code, listing.Body.String())
	}
	data, _ := decodeEnvelope(t, listing)
	var catalog struct{ Tools []struct{ ID, Path string } }
	if json.Unmarshal([]byte(acceptanceJSON(t, data)), &catalog) != nil || len(catalog.Tools) < 80 {
		t.Fatalf("incomplete business discovery: %s", data)
	}
	for _, tool := range catalog.Tools {
		if strings.Contains(tool.Path, "assistant") || strings.Contains(tool.Path, "clients") || strings.Contains(tool.Path, "/auth") || tool.Path == "/ai/custom" {
			t.Fatal("sensitive tool", tool.Path)
		}
	}
	var picture bytes.Buffer
	if err := png.Encode(&picture, image.NewRGBA(image.Rect(0, 0, 32, 32))); err != nil {
		t.Fatal(err)
	}
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, _ := writer.CreateFormFile("file", "reference.png")
	_, _ = part.Write(picture.Bytes())
	_ = writer.WriteField("kind", "image")
	_ = writer.WriteField("width", "32")
	_ = writer.WriteField("height", "32")
	_ = writer.Close()
	r := httptest.NewRequest("POST", "http://127.0.0.1:54321/api/resources", &body)
	r.RemoteAddr = "127.0.0.1:9999"
	r.Header.Set("Content-Type", writer.FormDataContentType())
	r.Header.Set("X-Beeftv-Client", reg.ID)
	r.Header.Set("Authorization", "Bearer "+token)
	upload := httptest.NewRecorder()
	h.rt.Handler().ServeHTTP(upload, r)
	if upload.Code != 200 {
		t.Fatal(upload.Code, upload.Body.String())
	}
	raw, _ := decodeEnvelope(t, upload)
	var uploaded struct {
		Resource model.Resource `json:"resource"`
	}
	if err = json.Unmarshal([]byte(acceptanceJSON(t, raw)), &uploaded); err != nil {
		t.Fatal(err)
	}
	if uploaded.Resource.ID == "" {
		t.Fatal("upload did not persist resource")
	}
	file := call("GET", "/resources/"+uploaded.Resource.ID+"/file", "")
	if file.Code != 200 || !bytes.Equal(file.Body.Bytes(), picture.Bytes()) {
		t.Fatal("owned media download differs", file.Code)
	}
	visible := true
	timeline := editing.Project{Version: 2, DurationMs: 1000, Tracks: []editing.Track{{ID: "v", Kind: "video", Visible: &visible}}, Clips: []editing.Clip{{ID: "pic", Kind: "image", TrackID: "v", DurationMs: 1000, NodeID: "pic", DirectMedia: &editing.DirectMedia{ID: "pic", Kind: "image", StorageKey: "resource:" + uploaded.Resource.ID}}}}
	render := call("POST", "/timeline/renders", acceptanceJSON(t, map[string]any{"timeline": timeline, "clientOperationId": "external-render-once"}))
	if render.Code != 200 {
		t.Fatal("external render requires no UI approval", render.Code, render.Body.String())
	}
	var task model.Task
	taskRaw, _ := decodeEnvelope(t, render)
	if json.Unmarshal([]byte(acceptanceJSON(t, taskRaw)), &task) != nil || task.Status != model.TaskStatusQueued {
		t.Fatal("real render task not queued", taskRaw)
	}
	getTask := call("GET", "/tasks/"+task.ID, "")
	if getTask.Code != 200 {
		t.Fatal(getTask.Code, getTask.Body.String())
	}
	move := call("POST", "/ops/canvas.node.move", acceptanceJSON(t, map[string]any{"opId": "external-move", "params": map[string]any{"canvasId": canvas, "nodeId": "n1", "expectedRevision": rev, "position": map[string]any{"x": 64, "y": 32}}}))
	if move.Code != 200 {
		t.Fatal(move.Code, move.Body.String())
	}
	for _, endpoint := range []string{"/agent-clients", "/assistant/host/config", "/assistant/runtime/turns/abc", "/ops/clients", "/skills/market/authorization", "/skills/market/publish-plans", "/skills/market/submissions"} {
		if out := call("GET", endpoint, ""); out.Code != http.StatusForbidden {
			t.Fatalf("credential/runtime management exposed %s: %d", endpoint, out.Code)
		}
	}
	for _, endpoint := range []string{"/skills/market/authorization/start", "/skills/market/publish-plans/forged/upload", "/skills/market/publish-plans/forged/submit", "/business/market/publish"} {
		if out := call("POST", endpoint, `{"confirmed":true}`); out.Code != http.StatusForbidden {
			t.Fatalf("publishing confirmation exposed %s: %d", endpoint, out.Code)
		}
	}
	foreign := model.Resource{ID: "foreign-business-resource", UserID: "foreign-owner", ObjectKey: "not-a-real-file", Status: model.ResourceStatusReady, MimeType: "image/png"}
	if err = h.rt.db.Create(&foreign).Error; err != nil {
		t.Fatal(err)
	}
	if out := call("GET", "/resources/"+foreign.ID+"/file", ""); out.Code == 200 {
		t.Fatal("foreign resource exposed")
	}
	ro, roToken, err := agentops.NewClientRegistry(h.dataDir).Register("old-readonly", agentops.ClientReadOnly)
	if err != nil {
		t.Fatal(err)
	}
	for _, endpoint := range []string{"/timeline/renders", "/ai/models"} {
		denied := h.call(requestOptions{method: "POST", path: endpoint, body: `{"credentialRef":"beefapi-enterprise","baseUrl":"https://attacker.example/v1"}`, clientID: ro.ID, clientToken: roToken})
		if _, reason := decodeEnvelope(t, denied); denied.Code != 403 || reason != "read_only_client" {
			t.Fatal("legacy token silently elevated", endpoint, denied.Code, denied.Body.String())
		}
	}
	if _, err = h.rt.service.UserCanvasProject(owner, canvas); err != nil {
		t.Fatal(err)
	}
}
