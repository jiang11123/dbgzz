package plugins

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/protocol"
)

const protocolPluginMaxBytes = protocol.PluginManifestMaxBytes

// Runtime owns package blobs, the live protocol registry snapshot, and
// mutation concurrency. Production binds Store before adapters are published;
// SQLite is then the committed registry authority. Standalone file mode is
// retained for independent tests: plugin_registry.json is written only when
// Store is nil.
type Runtime struct {
	mu                    sync.RWMutex
	mutationMu            sync.Mutex
	store                 Store
	registryPath          string
	packageDir            string
	plugins               map[string]Record
	registry              *protocol.Registry
	testBeforeMutation    func()
	testFailCommit        func() error
	testFailWriteRegistry func() error
	testAfterCommit       func()
	testSkipPublish       bool
}

func NewRuntime(dataDir string) (*Runtime, error) {
	return newRuntime(dataDir, nil)
}

func NewRuntimeWithStore(dataDir string, store Store) (*Runtime, error) {
	if store == nil {
		return nil, fmt.Errorf("插件状态存储未初始化")
	}
	return newRuntime(dataDir, store)
}

func newRuntime(dataDir string, store Store) (*Runtime, error) {
	dataDir = strings.TrimSpace(dataDir)
	if dataDir == "" {
		return nil, errors.New("plugin data directory is empty")
	}
	var err error
	dataDir, err = filepath.Abs(dataDir)
	if err != nil {
		return nil, fmt.Errorf("plugin data directory is invalid: %w", err)
	}
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return nil, fmt.Errorf("create plugin registry directory: %w", err)
	}
	packageDir := filepath.Join(dataDir, "plugin-packages")
	if err := os.MkdirAll(packageDir, 0o700); err != nil {
		return nil, fmt.Errorf("create plugin package directory: %w", err)
	}
	center := &Runtime{
		store:        store,
		registryPath: filepath.Join(dataDir, "plugin_registry.json"),
		packageDir:   packageDir,
		plugins:      make(map[string]Record),
	}
	if err := center.open(); err != nil {
		return nil, err
	}
	return center, nil
}

func (c *Runtime) open() error {
	stored, found, err := c.loadAuthority()
	if err != nil {
		return err
	}
	if err := validateAuthorityRecords(stored); err != nil {
		if c.store != nil && !found {
			return fmt.Errorf("读取遗留插件 registry 失败：%w", err)
		}
		return fmt.Errorf("读取插件 registry 失败：%w", err)
	}
	next, err := c.reconcileBuiltIns(stored)
	if err != nil {
		return err
	}
	plugins, registry, err := materializeRecords(next)
	if err != nil {
		return err
	}
	if !found || !registryContentEqual(stored, next) {
		if err := c.persistRecords(next, persistExtras{}); err != nil {
			return err
		}
	}
	c.publishLive(plugins, registry)
	return nil
}

// RuntimeForTest builds an in-memory runtime for host tests that only need
// List/management. It does not touch the filesystem.
func RuntimeForTest(records map[string]Record) *Runtime {
	plugins := records
	if plugins == nil {
		plugins = map[string]Record{}
	}
	registry, _ := protocol.NewRegistry()
	return &Runtime{plugins: plugins, registry: registry}
}

func (c *Runtime) List() []View {
	if c == nil {
		return []View{}
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	items := make([]View, 0, len(c.plugins))
	for _, item := range c.plugins {
		items = append(items, clonePluginView(viewFromRecord(item)))
	}
	sort.Slice(items, func(i, j int) bool { return items[i].Manifest.ID < items[j].Manifest.ID })
	return items
}

func (c *Runtime) Registry() *protocol.Registry {
	if c == nil {
		return nil
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.registry
}

func (c *Runtime) Package(id string) ([]byte, string, error) {
	if c == nil {
		return nil, "", fmt.Errorf("插件运行时未初始化")
	}
	// Serialize with install/uninstall so the blob cannot vanish mid-read.
	// Live adapters are materialized from registry Raw, not from these bytes.
	c.beginMutation()
	defer c.endMutation()
	c.mu.RLock()
	record, ok := c.plugins[strings.TrimSpace(id)]
	packageDir := c.packageDir
	c.mu.RUnlock()
	if !ok {
		return nil, "", fmt.Errorf("插件 %q 不存在", id)
	}
	if record.PackagePath == "" || strings.TrimSpace(record.PackageSHA256) == "" {
		return nil, "", fmt.Errorf("插件 %q 没有可下载的包文件", id)
	}
	data, err := os.ReadFile(filepath.Join(packageDir, filepath.Base(record.PackagePath)))
	if err != nil {
		return nil, "", fmt.Errorf("读取插件包失败：%w", err)
	}
	if pluginHash(data) != strings.TrimSpace(record.PackageSHA256) {
		return nil, "", fmt.Errorf("插件 %q 包内容与登记哈希不一致", id)
	}
	return data, record.FileName, nil
}

func (c *Runtime) beginMutation() {
	if c.testBeforeMutation != nil {
		c.testBeforeMutation()
	}
	c.mutationMu.Lock()
}

func (c *Runtime) endMutation() {
	c.mutationMu.Unlock()
}

func (c *Runtime) captureLive() liveSnapshot {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return liveSnapshot{plugins: c.plugins, registry: c.registry}
}

func (c *Runtime) restoreLive(snap liveSnapshot) {
	if snap.plugins == nil {
		return
	}
	c.mu.Lock()
	c.plugins = snap.plugins
	c.registry = snap.registry
	c.mu.Unlock()
}

func (c *Runtime) publishLive(plugins map[string]Record, registry *protocol.Registry) {
	c.mu.Lock()
	c.plugins = plugins
	c.registry = registry
	c.mu.Unlock()
}

func (c *Runtime) failNextCommit(err error) {
	c.testFailCommit = func() error {
		c.testFailCommit = nil
		return err
	}
}

func (c *Runtime) failNextWriteRegistry(err error) {
	c.testFailWriteRegistry = func() error {
		c.testFailWriteRegistry = nil
		return err
	}
}

func (c *Runtime) skipNextPublish() {
	c.testSkipPublish = true
}

func officialPluginPackageDir() (string, error) {
	return generation.OfficialPluginPackageDir()
}
