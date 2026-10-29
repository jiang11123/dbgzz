package app

import (
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestImageDeliveryRetainsEncryptedAuthUntilMaterialized(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	s, db, _, _ := creationTestService(t)
	png, _ := base64.StdEncoding.DecodeString(strings.SplitN(tinyPNGDataURL, ",", 2)[1])
	gets := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gets++
		if r.Method != "GET" || r.Header.Get("Authorization") != "Bearer download-secret" || r.Header.Get("X-Provider") != "fixture" {
			t.Error("download lost original auth")
		}
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(png)
	}))
	defer srv.Close()
	task := model.Task{ID: "authenticated-image", UserID: "user", Type: "canvas_image", Status: model.TaskStatusRunning,
		InputJSON: `{"mode":"image","referenceImages":["private-reference"],"config":{"interfaceType":"openai-image","apiFormat":"openai","baseUrl":"` + srv.URL + `","apiKey":"download-secret","headers":[{"name":"X-Provider","value":"fixture"}],"systemPrompt":"private-prompt"}}`}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	result := []byte(`{"mode":"image","images":[{"url":"` + srv.URL + `/image.png"}]}`)
	if err := s.saveTaskCompletionWithinStorageQuota(&task, result, nil, false); err != nil {
		t.Fatal(err)
	}
	stored, err := s.repo.Task(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(stored.InputJSON, "download-secret") || strings.Contains(stored.InputJSON, "private-reference") || strings.Contains(stored.InputJSON, "private-prompt") || !strings.Contains(stored.InputJSON, encryptedSettingPrefix) {
		t.Fatal("completion did not retain only encrypted download configuration")
	}
	if strings.Contains(taskForOutput(*stored).InputJSON, "imageDeliveryCipher") {
		t.Fatal("public task exposed download configuration")
	}
	adapter := generationDeliveryMediaAdapter{service: s}
	if headers, err := adapter.imageDownloadHeaders("user", task.ID+":0", "image", "https://8.8.8.8/image.png"); err != nil || len(headers) != 0 {
		t.Fatalf("external download received provider auth: %v", err)
	}
	if _, err := adapter.imageDownloadHeaders("other", task.ID+":0", "image", srv.URL+"/image.png"); err == nil {
		t.Fatal("foreign owner obtained download auth")
	}
	if err := s.DeliverSucceededTask(*stored); err != nil {
		t.Fatal(err)
	}
	stored, err = s.repo.Task(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if gets != 1 || strings.Contains(stored.InputJSON, "imageDeliveryCipher") {
		t.Fatalf("download/secret cleanup: gets=%d input=%s", gets, stored.InputJSON)
	}
	if stored.WorkflowSourceCipher == "" {
		t.Fatal("image result delivery removed reusable source snapshot")
	}
}
