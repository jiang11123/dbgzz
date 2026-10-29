package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func TestDBRuntimeVideoRestartRecovery(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	for _, missingID := range []bool{false, true} {
		name := "original-id"
		if missingID {
			name = "missing-id"
		}
		t.Run(name, func(t *testing.T) {
			var posts, polls atomic.Int64
			var upstream *httptest.Server
			upstream = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if r.Method == "POST" {
					posts.Add(1)
					if missingID {
						_, _ = w.Write([]byte(`{"code":"success","data":{}}`))
						return
					}
					_, _ = w.Write([]byte(`{"code":"success","data":{"task_id":"persisted-provider-id"}}`))
					return
				}
				if r.URL.Path == "/video.mp4" {
					w.Header().Set("Content-Type", "video/mp4")
					_, _ = w.Write([]byte("matrix video bytes"))
					return
				}
				if r.URL.Path != "/v1/video/generations/persisted-provider-id" {
					t.Errorf("wrong recovery URL %s", r.URL.Path)
				}
				polls.Add(1)
				_, _ = w.Write([]byte(`{"code":"success","data":{"task_id":"persisted-provider-id","status":"SUCCESS","result_url":"` + upstream.URL + `/video.mp4"}}`))
			}))
			defer upstream.Close()
			dir := t.TempDir()
			s, db := openDBRuntimeMatrix(t, dir)
			task, err := s.CreateTask("local", dbRuntimeRequest("video", upstream.URL))
			if err != nil {
				t.Fatal(err)
			}
			if missingID {
				if err := s.taskWorker().processNextTask(); err == nil {
					t.Fatal("missing ID unexpectedly succeeded")
				}
			} else {
				// Stop after the real accepted response was durably recorded, before polling.
				claimed, err := s.repo.ClaimNextTask("matrix-before-restart", 0)
				if err != nil || claimed == nil {
					t.Fatalf("claim: %v", err)
				}
				ctx := withProviderAnalytics(context.Background(), s, *claimed)
				input := canvasGenerationInput{Mode: "video", Config: providerConfig{BaseURL: upstream.URL, APIKey: "fixture-key", Model: "fixture-model", InterfaceType: "newapi-channel-2"}}
				policy := fastVideoPollPolicy()
				policy.InitialDelay = time.Millisecond
				policy.Sleep = func(context.Context, time.Duration) error { return context.Canceled }
				_, err = runProtocolAdapterTaskWithPolicy(ctx, input, recoveryTestAdapter(t), policy)
				if !errors.Is(err, context.Canceled) || polls.Load() != 0 {
					t.Fatalf("fixture did not stop between submission and polling: err=%v polls=%d", err, polls.Load())
				}
				stored, err := s.repo.Task(task.ID)
				if err != nil || stored.ProviderRequestID != "persisted-provider-id" {
					t.Fatalf("accepted ID not persisted: %+v %v", stored, err)
				}
			}
			closeDBRuntimeMatrix(t, s, db)
			s, db = openDBRuntimeMatrix(t, dir)
			defer closeDBRuntimeMatrix(t, s, db)
			if !missingID {
				// Advance only the scheduler's due time; preserve the persisted provider ID and request.
				if err := db.Model(&model.Task{}).Where("id = ?", task.ID).Update("next_poll_at", nil).Error; err != nil {
					t.Fatal(err)
				}
			}
			if err := s.taskWorker().processNextTask(); err != nil {
				t.Fatal(err)
			}
			stored, err := s.repo.Task(task.ID)
			if err != nil {
				t.Fatal(err)
			}
			if posts.Load() != 1 {
				t.Fatalf("restart resubmitted: %d", posts.Load())
			}
			if missingID {
				if _, err := s.QueryFailedVideoTask(context.Background(), "local", task.ID); err == nil {
					t.Fatal("manual query accepted a missing provider ID")
				}
				if stored.Status != model.TaskStatusFailed || stored.Stage != "submission_unknown" || polls.Load() != 0 {
					t.Fatalf("missing ID not retained for confirmation: %+v polls=%d", stored, polls.Load())
				}
			} else if stored.Status != model.TaskStatusSucceeded || stored.ProviderRequestID != "persisted-provider-id" || polls.Load() == 0 {
				t.Fatalf("original task did not recover: %+v polls=%d", stored, polls.Load())
			}
			t.Logf("restart task=%s providerID=%s stage=%s submissions=%d polls=%d", task.ID, stored.ProviderRequestID, stored.Stage, posts.Load(), polls.Load())
		})
	}
}

// This uses the product migration, admission and worker with a disk database.
// All provider traffic terminates at this test's loopback fixture.
func TestDBRuntimeGenerationMatrix(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	for _, mode := range []string{"text", "image", "video"} {
		for _, outcome := range []string{"success", "failure"} {
			t.Run(mode+"/"+outcome, func(t *testing.T) {
				var posts atomic.Int64
				var upstream *httptest.Server
				upstream = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					w.Header().Set("Content-Type", "application/json")
					w.Header().Set("X-Request-ID", "matrix-request")
					if r.Method == http.MethodPost {
						posts.Add(1)
					}
					if outcome == "failure" {
						w.WriteHeader(400)
						_, _ = w.Write([]byte(`{"error":{"code":"invalid_size","message":"fixture rejection"}}`))
						return
					}
					switch r.URL.Path {
					case "/v1/chat/completions":
						_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"matrix text output"}}]}`))
					case "/v1/images/generations":
						_, _ = w.Write([]byte(`{"data":[{"b64_json":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9l8AAAAASUVORK5CYII="}]}`))
					case "/v1/video/generations":
						_, _ = w.Write([]byte(`{"code":"success","data":{"task_id":"matrix-original"}}`))
					case "/v1/video/generations/matrix-original":
						_, _ = w.Write([]byte(`{"code":"success","data":{"task_id":"matrix-original","status":"SUCCESS","result_url":"` + upstream.URL + `/video.mp4"}}`))
					case "/video.mp4":
						w.Header().Set("Content-Type", "video/mp4")
						_, _ = w.Write([]byte("matrix video bytes"))
					default:
						t.Errorf("unexpected provider request %s %s", r.Method, r.URL.Path)
						http.NotFound(w, r)
					}
				}))
				defer upstream.Close()
				dir := t.TempDir()
				s, db := openDBRuntimeMatrix(t, dir)
				task, err := s.CreateTask("local", dbRuntimeRequest(mode, upstream.URL))
				if err != nil {
					t.Fatal(err)
				}
				workerErr := s.taskWorker().processNextTask()
				if outcome == "success" && workerErr != nil {
					t.Fatal(workerErr)
				}
				closeDBRuntimeMatrix(t, s, db)
				s, db = openDBRuntimeMatrix(t, dir)
				defer closeDBRuntimeMatrix(t, s, db)
				stored, err := s.repo.Task(task.ID)
				if err != nil {
					t.Fatal(err)
				}
				want := model.TaskStatusSucceeded
				if outcome == "failure" {
					want = model.TaskStatusFailed
				}
				if stored.Status != want {
					t.Fatalf("status=%s stage=%s error=%s worker=%v", stored.Status, stored.Stage, stored.Error, workerErr)
				}
				if posts.Load() != 1 {
					t.Fatalf("provider submissions=%d", posts.Load())
				}
				if outcome == "failure" {
					rows, err := s.TasksWithOptions("local", TaskListOptions{Limit: 10})
					if err != nil || len(rows) != 1 || rows[0].FailureDiagnostics == nil {
						t.Fatalf("restored diagnostic list=%+v err=%v", rows, err)
					}
					d := rows[0].FailureDiagnostics
					if d.RequestID != "matrix-request" || len(d.Requests) == 0 || d.Requests[0].HTTPStatus != 400 {
						t.Fatalf("persisted diagnostics=%+v", d)
					}
				} else {
					raw, _ := json.Marshal(stored)
					if !strings.Contains(string(raw), "matrix text output") && mode == "text" {
						t.Fatalf("text output missing: %s", raw)
					}
					if mode != "text" && !strings.Contains(string(raw), "resource:") {
						t.Fatalf("persisted media output missing: %s", raw)
					}
				}
				t.Logf("disk reopen: task=%s mode=%s outcome=%s submissions=%d", task.ID, mode, outcome, posts.Load())
			})
		}
	}
}

func dbRuntimeRequest(mode, base string) CreateTaskRequest {
	protocol := map[string]string{"text": "chat-completion", "image": "openai-image", "video": "newapi-channel-2"}[mode]
	return CreateTaskRequest{Type: "canvas_" + mode, Prompt: "matrix fixture", Input: map[string]any{"mode": mode, "config": map[string]any{"baseUrl": base, "apiKey": "fixture-key", "model": "fixture-model", "interfaceType": protocol}}}
}

func openDBRuntimeMatrix(t *testing.T, dir string) (*Service, *gorm.DB) {
	t.Helper()
	db, err := database.Open(database.Config{DataDir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if err = database.ConfigurePool(db); err != nil {
		t.Fatal(err)
	}
	if err = database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	return NewLocal(repository.New(db), dir), db
}

func closeDBRuntimeMatrix(t *testing.T, s *Service, db *gorm.DB) {
	t.Helper()
	if err := s.Close(); err != nil {
		t.Error(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	if err := sqlDB.Close(); err != nil {
		t.Error(err)
	}
}
