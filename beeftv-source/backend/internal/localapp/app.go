package localapp

import (
	"context"
	"fmt"
)

type Options struct {
	Workspace      WorkspacePort
	Projects       ProjectPort
	Assets         AssetPort
	Tasks          TaskPort
	Generation     GenerationPort
	ProviderConfig ProviderConfigPort
	Lifecycle      Lifecycle
}

// App is the desktop-only composition root. Legacy is a temporary HTTP
// adapter, not a source of dependencies for new local modules.
type App struct {
	Workspace      WorkspacePort
	Projects       ProjectPort
	Assets         AssetPort
	Tasks          TaskPort
	Generation     GenerationPort
	ProviderConfig ProviderConfigPort

	lifecycle Lifecycle
}

func New(options Options) (*App, error) {
	missing := ""
	switch {
	case options.Workspace == nil:
		missing = "workspace"
	case options.Projects == nil:
		missing = "projects"
	case options.Assets == nil:
		missing = "assets"
	case options.Tasks == nil:
		missing = "tasks"
	case options.Generation == nil:
		missing = "generation"
	case options.ProviderConfig == nil:
		missing = "provider config"
	case options.Lifecycle == nil:
		missing = "lifecycle"
	}
	if missing != "" {
		return nil, fmt.Errorf("local app requires %s port", missing)
	}
	return &App{
		Workspace: options.Workspace, Projects: options.Projects, Assets: options.Assets,
		Tasks: options.Tasks, Generation: options.Generation, ProviderConfig: options.ProviderConfig,
		lifecycle: options.Lifecycle,
	}, nil
}

func (a *App) Start()                         { a.lifecycle.StartWorker() }
func (a *App) Stop(ctx context.Context) error { return a.lifecycle.StopWorker(ctx) }
func (a *App) Close() error                   { return a.lifecycle.Close() }
