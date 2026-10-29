package plugins

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"infinite-canvas/backend/internal/protocol"
)

func decodeRegistryJSON(data []byte) ([]RegistryRecord, error) {
	if len(data) > protocol.PluginManifestMaxBytes*64 {
		return nil, fmt.Errorf("插件 registry 超过大小限制")
	}
	var records []RegistryRecord
	if err := json.Unmarshal(data, &records); err != nil {
		return nil, fmt.Errorf("读取插件 registry 失败：%w", err)
	}
	return records, nil
}

func (c *Runtime) readRegistry() ([]RegistryRecord, error) {
	data, err := os.ReadFile(c.registryPath)
	if errors.Is(err, os.ErrNotExist) {
		return []RegistryRecord{}, nil
	}
	if err != nil {
		return nil, err
	}
	return decodeRegistryJSON(data)
}

func (c *Runtime) writeRegistry(records []RegistryRecord) error {
	if hook := c.testFailWriteRegistry; hook != nil {
		if err := hook(); err != nil {
			return err
		}
	}
	data, err := json.MarshalIndent(records, "", "  ")
	if err != nil {
		return err
	}
	return writePluginFile(c.registryPath, data)
}

func (c *Runtime) importLegacyRegistry() ([]RegistryRecord, error) {
	data, err := os.ReadFile(c.registryPath)
	if errors.Is(err, os.ErrNotExist) {
		return []RegistryRecord{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("读取遗留插件 registry 失败：%w", err)
	}
	records, err := decodeRegistryJSON(data)
	if err != nil {
		return nil, fmt.Errorf("读取遗留插件 registry 失败：%w", err)
	}
	return records, nil
}

func (c *Runtime) loadAuthority() ([]RegistryRecord, bool, error) {
	if c.store != nil {
		records, found, err := c.store.LoadPluginRegistry()
		if err != nil {
			return nil, false, fmt.Errorf("读取插件 registry：%w", err)
		}
		if found {
			return records, true, nil
		}
		imported, err := c.importLegacyRegistry()
		if err != nil {
			return nil, false, err
		}
		return imported, false, nil
	}
	_, statErr := os.Stat(c.registryPath)
	records, err := c.readRegistry()
	if err != nil {
		return nil, false, err
	}
	return records, statErr == nil, nil
}

func (c *Runtime) currentRecords() ([]RegistryRecord, error) {
	if c.store != nil {
		records, found, err := c.store.LoadPluginRegistry()
		if err != nil {
			return nil, fmt.Errorf("读取插件 registry：%w", err)
		}
		if !found {
			return nil, fmt.Errorf("插件 registry 未初始化")
		}
		return cloneRegistryRecords(records), nil
	}
	return c.readRegistry()
}

func (c *Runtime) persistRecords(records []RegistryRecord, extras persistExtras) error {
	if hook := c.testFailCommit; hook != nil {
		c.testFailCommit = nil
		if err := hook(); err != nil {
			return err
		}
	}
	if err := validateAuthorityRecords(records); err != nil {
		return fmt.Errorf("插件 registry 候选无效：%w", err)
	}
	if c.store != nil {
		return c.store.CommitPluginRegistry(RegistryCommit{
			Records:        records,
			Platform:       extras.platform,
			DeletePluginID: extras.deleteID,
		})
	}
	if extras.platform != nil || extras.deleteID != "" {
		return fmt.Errorf("插件状态存储未初始化")
	}
	return c.writeRegistry(records)
}

func (c *Runtime) persistedRecordsForGC() ([]RegistryRecord, error) {
	if c.store != nil {
		records, found, err := c.store.LoadPluginRegistry()
		if err != nil {
			return nil, err
		}
		if !found {
			return []RegistryRecord{}, nil
		}
		return records, nil
	}
	return c.readRegistry()
}

func blobFileName(hash string) string {
	hash = strings.TrimSpace(hash)
	if hash == "" {
		return ""
	}
	return hash + protocol.PluginPackageExtension
}

func referencedBlobNames(records []RegistryRecord) map[string]struct{} {
	refs := make(map[string]struct{}, len(records))
	for _, record := range records {
		name := filepath.Base(strings.TrimSpace(record.PackagePath))
		if name == "" || name == "." || name == string(filepath.Separator) {
			continue
		}
		refs[name] = struct{}{}
	}
	return refs
}

func (c *Runtime) liveBlobReferenced(name string) bool {
	name = filepath.Base(strings.TrimSpace(name))
	if name == "" || name == "." || name == string(filepath.Separator) {
		return false
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	for _, record := range c.plugins {
		if filepath.Base(strings.TrimSpace(record.PackagePath)) == name {
			return true
		}
	}
	return false
}

func (c *Runtime) discardBlobIfUnreferenced(name string) {
	name = filepath.Base(strings.TrimSpace(name))
	if name == "" || name == "." || name == string(filepath.Separator) {
		return
	}
	if c.liveBlobReferenced(name) {
		return
	}
	stored, err := c.persistedRecordsForGC()
	if err != nil {
		return
	}
	if _, referenced := referencedBlobNames(stored)[name]; referenced {
		return
	}
	_ = os.Remove(filepath.Join(c.packageDir, name))
}

func materializeRecords(stored []RegistryRecord) (map[string]Record, *protocol.Registry, error) {
	plugins := make(map[string]Record, len(stored))
	for _, storedRecord := range stored {
		data := storedRecord.Raw
		if len(data) > protocolPluginMaxBytes {
			return nil, nil, fmt.Errorf("plugin %s exceeds %d bytes", storedRecord.ID, protocolPluginMaxBytes)
		}
		var manifest protocol.Manifest
		if err := json.Unmarshal(data, &manifest); err != nil {
			return nil, nil, fmt.Errorf("decode plugin %s: %w", storedRecord.ID, err)
		}
		metadata := manifest.Metadata
		if strings.TrimSpace(metadata.ID) == "" {
			return nil, nil, fmt.Errorf("plugin %s has no metadata id", storedRecord.ID)
		}
		if strings.TrimSpace(storedRecord.ID) != strings.TrimSpace(metadata.ID) {
			return nil, nil, fmt.Errorf("插件 %s 清单 ID 与记录 ID 不一致", storedRecord.ID)
		}
		if _, exists := plugins[metadata.ID]; exists {
			return nil, nil, fmt.Errorf("duplicate installed protocol %q", metadata.ID)
		}
		packageSHA256 := storedRecord.PackageSHA256
		if packageSHA256 == "" && strings.TrimSpace(storedRecord.PackagePath) == "" {
			packageSHA256 = pluginHash(data)
		}
		plugins[metadata.ID] = Record{Raw: append([]byte(nil), data...), Metadata: metadata, Source: storedRecord.Source, FileName: storedRecord.FileName, PackagePath: storedRecord.PackagePath, PackageSHA256: packageSHA256, SHA256: packageSHA256, InstalledAt: storedRecord.InstalledAt, UpdatedAt: storedRecord.UpdatedAt, Status: StatusInvalid}
	}
	registry, err := protocol.NewRegistry()
	if err != nil {
		return nil, nil, err
	}
	for id, record := range plugins {
		var manifest protocol.Manifest
		if err := json.Unmarshal(record.Raw, &manifest); err != nil {
			record.Error = err.Error()
			plugins[id] = record
			continue
		}
		adapters, loadErr := protocol.LoadInstalledProviders(record.Raw, nil)
		if loadErr != nil {
			record.Metadata.Enabled = false
			record.Metadata.UnavailableReason = loadErr.Error()
			record.Error = loadErr.Error()
			_ = registry.Register(protocol.UnavailableAdapter{Info: record.Metadata})
			plugins[id] = record
			continue
		}
		if !record.Metadata.Enabled {
			record.Status = StatusDisabled
			for _, adapter := range adapters {
				info := adapter.Metadata()
				info.Enabled = false
				_ = registry.Register(protocol.UnavailableAdapter{Info: info})
			}
			plugins[id] = record
			continue
		}
		registrationFailed := false
		for _, adapter := range adapters {
			if err := registry.Register(adapter); err != nil {
				record.Error = err.Error()
				registrationFailed = true
			}
		}
		if registrationFailed {
			plugins[id] = record
			continue
		}
		record.Status = StatusEnabled
		plugins[id] = record
	}
	return plugins, registry, nil
}

func writePluginFile(path string, data []byte) error {
	directory := filepath.Dir(path)
	temporary, err := os.CreateTemp(directory, ".plugin-*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return err
	}
	return syncDirectory(directory)
}

func ensurePluginBlob(path string, data []byte) (bool, error) {
	hash := pluginHash(data)
	if filepath.Base(path) != blobFileName(hash) {
		return false, fmt.Errorf("插件包路径与内容哈希不一致")
	}
	existing, err := os.ReadFile(path)
	if err == nil {
		if pluginHash(existing) != hash {
			return false, fmt.Errorf("插件包 %s 已存在但内容与哈希不一致", filepath.Base(path))
		}
		return false, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	if err := writePluginFile(path, data); err != nil {
		return false, err
	}
	return true, nil
}

func validateAuthorityRecords(records []RegistryRecord) error {
	seen := make(map[string]struct{}, len(records))
	for _, record := range records {
		id := strings.TrimSpace(record.ID)
		if id == "" {
			return fmt.Errorf("插件 registry 记录缺少 ID")
		}
		if _, exists := seen[id]; exists {
			return fmt.Errorf("插件 registry 记录 ID %q 重复", id)
		}
		seen[id] = struct{}{}
		if err := validateAuthorityRecord(record); err != nil {
			return err
		}
	}
	return nil
}

func validateAuthorityRecord(record RegistryRecord) error {
	id := strings.TrimSpace(record.ID)
	if len(record.Raw) == 0 {
		return fmt.Errorf("插件 %s 缺少清单", id)
	}
	if !json.Valid(record.Raw) {
		return fmt.Errorf("插件 %s 清单不是合法 JSON", id)
	}
	var manifest protocol.Manifest
	if err := json.Unmarshal(record.Raw, &manifest); err != nil {
		return fmt.Errorf("decode plugin %s: %w", id, err)
	}
	metadataID := strings.TrimSpace(manifest.Metadata.ID)
	if metadataID == "" {
		return fmt.Errorf("plugin %s has no metadata id", id)
	}
	if metadataID != id {
		return fmt.Errorf("插件 %s 清单 ID 与记录 ID 不一致", id)
	}
	if err := validateRecordSource(record.Source); err != nil {
		return fmt.Errorf("插件 %s：%w", id, err)
	}
	if err := validateRecordPackageIdentity(record); err != nil {
		return fmt.Errorf("插件 %s：%w", id, err)
	}
	return nil
}

func validateRecordSource(source string) error {
	switch strings.TrimSpace(source) {
	case OriginOfficial, OriginSystem, OriginUploaded, "bundled":
		return nil
	case "":
		return fmt.Errorf("缺少来源")
	default:
		return fmt.Errorf("未知来源 %q", strings.TrimSpace(source))
	}
}

func validateRecordPackageIdentity(record RegistryRecord) error {
	path := strings.TrimSpace(record.PackagePath)
	hash := strings.TrimSpace(record.PackageSHA256)
	if name := strings.TrimSpace(record.FileName); name != "" {
		if err := validateRecordBaseName(name); err != nil {
			return fmt.Errorf("文件名无效")
		}
	}
	if path != "" {
		if err := validateRecordBaseName(path); err != nil {
			return err
		}
	}
	if path == "" || hash == "" {
		return nil
	}
	if !validPackageSHA256(hash) {
		return fmt.Errorf("包哈希无效")
	}
	if blobFileName(hash) != path {
		return fmt.Errorf("包路径与哈希不一致")
	}
	return nil
}

func validateRecordBaseName(name string) error {
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, `/\`) || filepath.Base(name) != name {
		return fmt.Errorf("路径无效")
	}
	return nil
}

func validPackageSHA256(hash string) bool {
	if len(hash) != 64 {
		return false
	}
	_, err := hex.DecodeString(hash)
	return err == nil
}

func pluginHash(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

func cloneRegistryRecords(records []RegistryRecord) []RegistryRecord {
	out := make([]RegistryRecord, len(records))
	for i, record := range records {
		out[i] = record
		if record.Raw != nil {
			out[i].Raw = append(json.RawMessage(nil), record.Raw...)
		}
	}
	return out
}

func registryContentEqual(a, b []RegistryRecord) bool {
	if len(a) != len(b) {
		return false
	}
	index := make(map[string]RegistryRecord, len(a))
	for _, record := range a {
		index[record.ID] = record
	}
	for _, record := range b {
		prev, ok := index[record.ID]
		if !ok || registryRecordContentChanged(prev, record) {
			return false
		}
	}
	return true
}

func registryRecordContentChanged(prev, next RegistryRecord) bool {
	return prev.ID != next.ID ||
		!bytes.Equal(prev.Raw, next.Raw) ||
		prev.Source != next.Source ||
		prev.FileName != next.FileName ||
		prev.PackagePath != next.PackagePath ||
		prev.PackageSHA256 != next.PackageSHA256
}
