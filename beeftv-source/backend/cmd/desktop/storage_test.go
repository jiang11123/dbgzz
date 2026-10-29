package main

import (
	"bytes"
	"context"
	"encoding/json"
	"infinite-canvas/backend/internal/desktopstorage"
	"infinite-canvas/backend/internal/workspace"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

func TestNativeMigrationPreservesSQLiteProjectMediaAndEncryptedModelAfterRestart(t *testing.T) {
	root := filepath.Join(t.TempDir(), "profile")
	target := filepath.Join(t.TempDir(), "selected")
	if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
		t.Fatal(err)
	}
	parent, err := filepath.EvalSymlinks(filepath.Dir(target))
	if err != nil {
		t.Fatal(err)
	}
	target = filepath.Join(parent, "selected")
	app := newDesktopApp(root)
	app.storageRoot = root
	if err := app.start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer app.stop(context.Background())
	request := func(method, path string, body io.Reader, contentType string) []byte {
		t.Helper()
		runtime := app.runtime()
		req, err := http.NewRequest(method, runtime.BaseURL()+path, body)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("X-Desktop-Token", runtime.LaunchToken())
		if contentType != "" {
			req.Header.Set("Content-Type", contentType)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		data, _ := io.ReadAll(res.Body)
		if res.StatusCode != 200 {
			t.Fatalf("%s %s status %d: %s", method, path, res.StatusCode, data)
		}
		return data
	}
	project := request("POST", "/projects", bytes.NewBufferString(`{"name":"migration-project"}`), "application/json")
	request("PUT", "/canvas-projects/migration-canvas", bytes.NewBufferString(`{"project":{"id":"migration-canvas","revision":0,"title":"migration-canvas-title","nodes":[],"connections":[],"chatSessions":[],"createdAt":"2026-10-10T00:00:00Z","updatedAt":"2026-10-10T00:00:00Z"}}`), "application/json")
	var envelope struct {
		Data struct {
			Project struct {
				ID string `json:"id"`
			} `json:"project"`
		} `json:"data"`
	}
	if err := json.Unmarshal(project, &envelope); err != nil || envelope.Data.Project.ID == "" {
		t.Fatal("project not created")
	}
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", "fixture.txt")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = part.Write([]byte("migrated-resource"))
	_ = writer.WriteField("kind", "document")
	_ = writer.Close()
	resource := request("POST", "/resources", &body, writer.FormDataContentType())
	var resourceEnvelope struct {
		Data struct {
			Resource struct {
				ID string `json:"id"`
			} `json:"resource"`
		} `json:"data"`
	}
	if err := json.Unmarshal(resource, &resourceEnvelope); err != nil || resourceEnvelope.Data.Resource.ID == "" {
		t.Fatal("resource not created")
	}
	config, err := workspace.NewProviderConfig(root)
	if err != nil {
		t.Fatal(err)
	}
	if err = config.SaveLocalModelConfig([]byte(`{"channels":[{"id":"personal","enabled":true,"apiKey":"migration-secret"}]}`)); err != nil {
		t.Fatal(err)
	}
	foreign := filepath.Join(t.TempDir(), "occupied")
	_ = os.MkdirAll(foreign, 0700)
	_ = os.WriteFile(filepath.Join(foreign, "foreign"), []byte("keep"), 0600)
	if _, err = app.MigrateStorage(foreign); err == nil {
		t.Fatal("accepted occupied target")
	}
	if app.dataDir != root || app.runtime() == nil {
		t.Fatal("invalid destination closed original workspace")
	}
	if _, err = app.MigrateStorage(target); err != nil {
		t.Fatal(err)
	}
	if got, err := desktopstorage.Resolve(root); err != nil || got != target {
		t.Fatalf("saved selection %q %v", got, err)
	}
	if err = app.stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	reopened, err := desktopstorage.Resolve(root)
	if err != nil {
		t.Fatal(err)
	}
	app.dataDir = reopened
	if err = app.start(context.Background()); err != nil {
		t.Fatal(err)
	}
	data := request("GET", "/projects/"+envelope.Data.Project.ID, nil, "")
	if !bytes.Contains(data, []byte("migration-project")) {
		t.Fatal("SQLite project lost")
	}
	canvas := request("GET", "/canvas-projects/migration-canvas", nil, "")
	if !bytes.Contains(canvas, []byte("migration-canvas-title")) {
		t.Fatal("canvas project lost")
	}
	data = request("GET", "/resources/"+resourceEnvelope.Data.Resource.ID+"/file", nil, "")
	if string(data) != "migrated-resource" {
		t.Fatal("media lost")
	}
	config, err = workspace.NewProviderConfig(target)
	if err != nil {
		t.Fatal(err)
	}
	effective, _, err := config.LoadEffectiveModelConfig()
	encoded, _ := json.Marshal(effective)
	if err != nil || !bytes.Contains(encoded, []byte("migration-secret")) {
		t.Fatalf("encrypted config/key lost: %v", err)
	}
	if _, err = app.CleanupPreviousStorage(); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(filepath.Join(root, "open_ai_canvas.db")); !os.IsNotExist(err) {
		t.Fatal("old database retained")
	}
	data = request("GET", "/projects/"+envelope.Data.Project.ID, nil, "")
	if !bytes.Contains(data, []byte("migration-project")) {
		t.Fatal("cleanup damaged project")
	}
	if got, err := desktopstorage.Resolve(root); err != nil || got != target {
		t.Fatal("cleanup lost directory selection")
	}
}
