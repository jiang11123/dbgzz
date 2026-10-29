package app

import (
	"errors"
	"fmt"

	"infinite-canvas/backend/internal/plugins"
	"infinite-canvas/backend/internal/protocol"
)

// Plugin types remain exported from app as aliases while callers migrate to
// internal/plugins. The domain owns registry state and mutation; these aliases
// must not grow a second implementation.
type PluginView = plugins.View
type PluginManifestView = plugins.ManifestView
type pluginRecord = plugins.Record
type pluginRegistryRecord = plugins.RegistryRecord

type pluginRuntime struct {
	*plugins.Runtime
}

func newPluginRuntime(dataDir string) (*pluginRuntime, error) {
	runtime, err := plugins.NewRuntime(dataDir)
	if err != nil {
		return nil, err
	}
	return &pluginRuntime{Runtime: runtime}, nil
}

func newPluginRuntimeWithStore(dataDir string, store plugins.Store) (*pluginRuntime, error) {
	if store == nil {
		return nil, fmt.Errorf("插件状态存储未初始化")
	}
	runtime, err := plugins.NewRuntimeWithStore(dataDir, store)
	if err != nil {
		return nil, err
	}
	return &pluginRuntime{Runtime: runtime}, nil
}

func pluginRuntimeFromRecords(records map[string]pluginRecord) *pluginRuntime {
	return &pluginRuntime{Runtime: plugins.RuntimeForTest(records)}
}

func (c *pluginRuntime) list() []PluginView {
	if c == nil || c.Runtime == nil {
		return []PluginView{}
	}
	return c.Runtime.List()
}

func (c *pluginRuntime) registrySnapshot() *protocol.Registry {
	if c == nil || c.Runtime == nil {
		return nil
	}
	return c.Runtime.Registry()
}

func (c *pluginRuntime) install(data []byte, fileName string) (PluginView, error) {
	if c == nil || c.Runtime == nil {
		return PluginView{}, fmt.Errorf("插件运行时未初始化")
	}
	return c.Runtime.Install(data, fileName)
}

func (c *pluginRuntime) setEnabled(id string, enabled bool) (PluginView, error) {
	if c == nil || c.Runtime == nil {
		return PluginView{}, fmt.Errorf("插件运行时未初始化")
	}
	return c.Runtime.SetEnabled(id, enabled)
}

func (c *pluginRuntime) uninstall(id string) error {
	if c == nil || c.Runtime == nil {
		return fmt.Errorf("插件运行时未初始化")
	}
	return c.Runtime.Uninstall(id)
}

func (s *Service) pluginDomain() *plugins.Service {
	var runtime *plugins.Runtime
	if s != nil && s.pluginRuntime != nil {
		runtime = s.pluginRuntime.Runtime
	}
	var store plugins.Store
	if s != nil && s.repo != nil {
		store = plugins.NewRepositoryStore(s.repo)
	}
	return plugins.New(runtime, store)
}

func mapPluginAccessError(err error) error {
	if err == nil {
		return nil
	}
	var access *plugins.AccessError
	if errors.As(err, &access) {
		return Forbidden(access.Error())
	}
	return err
}

func bundledWorkflowPluginManifests() []protocol.Manifest {
	return plugins.BundledWorkflowManifests()
}
