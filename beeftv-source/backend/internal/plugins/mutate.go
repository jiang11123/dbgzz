package plugins

import (
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/protocol"
)

type liveSnapshot struct {
	plugins  map[string]Record
	registry *protocol.Registry
}

type persistExtras struct {
	platform *model.PluginPlatformState
	deleteID string
}

type stagedMutation struct {
	previousLive liveSnapshot
	nextDisk     []RegistryRecord
	nextPlugins  map[string]Record
	nextRegistry *protocol.Registry
	view         View
	oldBlob      string
	newBlob      string
	createdBlob  bool
	persisted    bool
	liveSwapped  bool
}

var errPublishInterrupted = errors.New("插件变更已提交，但内存发布未完成")

func (c *Runtime) Install(data []byte, fileName string) (View, error) {
	if c == nil {
		return View{}, fmt.Errorf("插件运行时未初始化")
	}
	c.beginMutation()
	defer c.endMutation()
	stage, err := c.stageInstallLocked(data, fileName)
	if err != nil {
		return View{}, err
	}
	if err := c.commitAndPublish(&stage, persistExtras{}); err != nil {
		c.abortUncommitted(&stage)
		return View{}, err
	}
	c.commitInstall(stage)
	return stage.view, nil
}

func (c *Runtime) stageInstallLocked(data []byte, fileName string) (stagedMutation, error) {
	if len(data) == 0 || len(data) > protocol.PluginPackageMaxBytes {
		return stagedMutation{}, fmt.Errorf("plugin package must be between 1 and %d bytes", protocol.PluginPackageMaxBytes)
	}
	pkg, err := protocol.ParsePluginPackage(data)
	if err != nil {
		return stagedMutation{}, err
	}
	manifest := pkg.Manifest
	if strings.HasPrefix(strings.TrimSpace(manifest.Runtime.Backend), "host:") {
		return stagedMutation{}, errors.New("上传插件不能使用宿主内置执行器")
	}
	if _, err := protocol.LoadInstalledProviders(pkg.ManifestRaw, nil); err != nil {
		return stagedMutation{}, err
	}
	c.mu.RLock()
	existing, exists := c.plugins[manifest.Metadata.ID]
	c.mu.RUnlock()
	if exists && IsBuiltInSource(existing.Source) {
		return stagedMutation{}, fmt.Errorf("内置插件 %q 不能通过上传覆盖", manifest.Metadata.ID)
	}
	manifest.Metadata.Enabled = !exists || existing.Metadata.Enabled
	manifestData, err := json.Marshal(manifest)
	if err != nil {
		return stagedMutation{}, err
	}
	hash := pluginHash(data)
	packageName := filepath.Base(strings.TrimSpace(fileName))
	if packageName == "." || packageName == "" || packageName == string(filepath.Separator) {
		packageName = manifest.Metadata.ID + protocol.PluginPackageExtension
	}
	blobName := blobFileName(hash)
	packagePath := filepath.Join(c.packageDir, blobName)
	createdBlob, err := ensurePluginBlob(packagePath, data)
	if err != nil {
		return stagedMutation{}, fmt.Errorf("保存插件包失败：%w", err)
	}
	stored, err := c.currentRecords()
	if err != nil {
		if createdBlob {
			c.discardBlobIfUnreferenced(blobName)
		}
		return stagedMutation{}, err
	}
	now := time.Now().UTC()
	newRecord := RegistryRecord{ID: manifest.Metadata.ID, Raw: manifestData, Source: OriginUploaded, FileName: packageName, PackagePath: blobName, PackageSHA256: hash, InstalledAt: now, UpdatedAt: now}
	if exists {
		newRecord.InstalledAt = existing.InstalledAt
		replaced := false
		for index := range stored {
			if stored[index].ID == manifest.Metadata.ID {
				stored[index] = newRecord
				replaced = true
				break
			}
		}
		if !replaced {
			stored = append(stored, newRecord)
		}
	} else {
		stored = append(stored, newRecord)
	}
	plugins, registry, err := materializeRecords(stored)
	if err != nil {
		if createdBlob {
			c.discardBlobIfUnreferenced(blobName)
		}
		return stagedMutation{}, err
	}
	view, err := viewFromPlugins(plugins, manifest.Metadata.ID)
	if err != nil {
		if createdBlob {
			c.discardBlobIfUnreferenced(blobName)
		}
		return stagedMutation{}, err
	}
	return stagedMutation{
		previousLive: c.captureLive(),
		nextDisk:     stored,
		nextPlugins:  plugins,
		nextRegistry: registry,
		view:         view,
		oldBlob:      existing.PackagePath,
		newBlob:      blobName,
		createdBlob:  createdBlob,
	}, nil
}

func (c *Runtime) commitAndPublish(stage *stagedMutation, extras persistExtras) error {
	if stage == nil {
		return errors.New("插件变更未准备")
	}
	if err := c.persistRecords(stage.nextDisk, extras); err != nil {
		return err
	}
	stage.persisted = true
	if c.testAfterCommit != nil {
		c.testAfterCommit()
	}
	if c.testSkipPublish {
		c.testSkipPublish = false
		return errPublishInterrupted
	}
	c.publishLive(stage.nextPlugins, stage.nextRegistry)
	stage.liveSwapped = true
	return nil
}

func (c *Runtime) abortUncommitted(stage *stagedMutation) {
	if stage == nil || stage.persisted {
		return
	}
	if stage.liveSwapped {
		c.restoreLive(stage.previousLive)
		stage.liveSwapped = false
	}
	if stage.createdBlob {
		c.discardBlobIfUnreferenced(stage.newBlob)
	}
}

func (c *Runtime) commitInstall(stage stagedMutation) {
	if stage.oldBlob == "" || stage.oldBlob == stage.newBlob {
		return
	}
	c.discardBlobIfUnreferenced(stage.oldBlob)
}

func (c *Runtime) SetEnabled(id string, enabled bool) (View, error) {
	if c == nil {
		return View{}, fmt.Errorf("插件运行时未初始化")
	}
	c.beginMutation()
	defer c.endMutation()
	return c.setEnabledLocked(id, enabled)
}

func (c *Runtime) setEnabledLocked(id string, enabled bool) (View, error) {
	stage, err := c.stageSetEnabledLocked(id, enabled)
	if err != nil {
		return View{}, err
	}
	if err := c.commitAndPublish(&stage, persistExtras{}); err != nil {
		c.abortUncommitted(&stage)
		return View{}, err
	}
	return stage.view, nil
}

func (c *Runtime) stageSetEnabledLocked(id string, enabled bool) (stagedMutation, error) {
	c.mu.RLock()
	record, ok := c.plugins[strings.TrimSpace(id)]
	c.mu.RUnlock()
	if !ok {
		return stagedMutation{}, fmt.Errorf("插件 %q 不存在", id)
	}
	var manifest protocol.Manifest
	if err := json.Unmarshal(record.Raw, &manifest); err != nil {
		return stagedMutation{}, err
	}
	manifest.Metadata.Enabled = enabled
	data, err := json.Marshal(manifest)
	if err != nil {
		return stagedMutation{}, err
	}
	stored, err := c.currentRecords()
	if err != nil {
		return stagedMutation{}, err
	}
	for index := range stored {
		if stored[index].ID == record.Metadata.ID {
			stored[index].Raw = data
			stored[index].UpdatedAt = time.Now().UTC()
		}
	}
	plugins, registry, err := materializeRecords(stored)
	if err != nil {
		return stagedMutation{}, err
	}
	view, err := viewFromPlugins(plugins, manifest.Metadata.ID)
	if err != nil {
		return stagedMutation{}, err
	}
	return stagedMutation{
		previousLive: c.captureLive(),
		nextDisk:     stored,
		nextPlugins:  plugins,
		nextRegistry: registry,
		view:         view,
	}, nil
}

func (c *Runtime) Uninstall(id string) error {
	if c == nil {
		return fmt.Errorf("插件运行时未初始化")
	}
	c.beginMutation()
	defer c.endMutation()
	stage, err := c.stageUninstallLocked(id)
	if err != nil {
		return err
	}
	extras := persistExtras{}
	if c.store != nil {
		extras.deleteID = strings.TrimSpace(id)
	}
	if err := c.commitAndPublish(&stage, extras); err != nil {
		c.abortUncommitted(&stage)
		if extras.deleteID != "" && !errors.Is(err, errPublishInterrupted) {
			return fmt.Errorf("清理插件状态：%w", err)
		}
		return err
	}
	c.commitUninstall(stage)
	return nil
}

func (c *Runtime) stageUninstallLocked(id string) (stagedMutation, error) {
	c.mu.RLock()
	record, ok := c.plugins[strings.TrimSpace(id)]
	c.mu.RUnlock()
	if !ok {
		return stagedMutation{}, fmt.Errorf("插件 %q 不存在", id)
	}
	if IsBuiltInSource(record.Source) {
		return stagedMutation{}, fmt.Errorf("内置插件 %q 不能卸载，可停用该插件", id)
	}
	stored, err := c.currentRecords()
	if err != nil {
		return stagedMutation{}, err
	}
	filtered := make([]RegistryRecord, 0, len(stored))
	for _, item := range stored {
		if item.ID != record.Metadata.ID {
			filtered = append(filtered, item)
		}
	}
	plugins, registry, err := materializeRecords(filtered)
	if err != nil {
		return stagedMutation{}, err
	}
	return stagedMutation{
		previousLive: c.captureLive(),
		nextDisk:     filtered,
		nextPlugins:  plugins,
		nextRegistry: registry,
		oldBlob:      record.PackagePath,
	}, nil
}

func (c *Runtime) commitUninstall(stage stagedMutation) {
	c.discardBlobIfUnreferenced(stage.oldBlob)
}

func viewFromPlugins(plugins map[string]Record, id string) (View, error) {
	record, ok := plugins[id]
	if !ok {
		return View{}, errors.New("插件保存后未加载")
	}
	return clonePluginView(viewFromRecord(record)), nil
}
