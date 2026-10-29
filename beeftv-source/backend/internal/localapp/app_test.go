package localapp

import (
	"context"
	"mime/multipart"
	"reflect"
	"testing"

	"infinite-canvas/backend/internal/model"
	localproject "infinite-canvas/backend/internal/project"
	localtask "infinite-canvas/backend/internal/task"
)

type fakePorts struct{}

func (fakePorts) WorkspaceOwner(string) (*model.User, error)          { return &model.User{}, nil }
func (fakePorts) ListProjects(string) ([]localproject.Summary, error) { return nil, nil }
func (fakePorts) Resources(string, int) ([]model.Resource, error)     { return nil, nil }
func (fakePorts) UploadLocalResource(string, *multipart.FileHeader, string, int, int, int64, ...string) (*model.Resource, error) {
	return nil, nil
}

func (fakePorts) TasksWithOptions(string, localtask.ListOptions) ([]localtask.Summary, error) {
	return nil, nil
}

func (fakePorts) CreateTimelineRenderTask(string, localtask.TimelineRenderCreateRequest) (*model.Task, error) {
	return nil, nil
}

func (fakePorts) CreateTimelineTranscriptionTask(string, localtask.TimelineTranscriptionCreateRequest) (*model.Task, error) {
	return nil, nil
}

func (fakePorts) CreateDepthCaptureTask(string, localtask.DepthCaptureCreateRequest) (*model.Task, error) {
	return nil, nil
}

func (fakePorts) CreateTask(string, localtask.CreateRequest) (*model.Task, error) { return nil, nil }
func (fakePorts) ReadLocalModelConfig() ([]byte, error)                           { return nil, nil }
func (fakePorts) SaveLocalModelConfig([]byte) error                               { return nil }
func (fakePorts) StartWorker()                                                    {}
func (fakePorts) StopWorker(context.Context) error                                { return nil }
func (fakePorts) Close() error                                                    { return nil }

var (
	_ TaskPort       = fakePorts{}
	_ GenerationPort = fakePorts{}
	_ TaskPort       = (*localtask.Service)(nil)
)

// 旧内置 Agent 的空端口已移除；这里锁定它不会以任何形式回到组合根。
func TestLocalCompositionRootDoesNotExposeAgentPort(t *testing.T) {
	appType := reflect.TypeOf(App{})
	for _, field := range []string{"Agent", "legacy"} {
		if _, ok := appType.FieldByName(field); ok {
			t.Fatalf("local composition root still exposes %s", field)
		}
	}
	optionsType := reflect.TypeOf(Options{})
	if _, ok := optionsType.FieldByName("Agent"); ok {
		t.Fatal("local composition root options still accept an Agent port")
	}
}

func TestNewRequiresEveryLocalPort(t *testing.T) {
	ports := fakePorts{}
	valid := Options{
		Workspace: ports, Projects: ports, Assets: ports, Tasks: ports,
		Generation: ports, ProviderConfig: ports, Lifecycle: ports,
	}
	app, err := New(valid)
	if err != nil || app == nil {
		t.Fatalf("New(valid) = (%v, %v), want app", app, err)
	}

	tests := []struct {
		name string
		omit func(*Options)
	}{
		{"workspace", func(o *Options) { o.Workspace = nil }},
		{"projects", func(o *Options) { o.Projects = nil }},
		{"assets", func(o *Options) { o.Assets = nil }},
		{"tasks", func(o *Options) { o.Tasks = nil }},
		{"generation", func(o *Options) { o.Generation = nil }},
		{"provider config", func(o *Options) { o.ProviderConfig = nil }},
		{"lifecycle", func(o *Options) { o.Lifecycle = nil }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			options := valid
			test.omit(&options)
			if _, err := New(options); err == nil {
				t.Fatal("New succeeded with a missing mandatory local port")
			}
		})
	}
}
