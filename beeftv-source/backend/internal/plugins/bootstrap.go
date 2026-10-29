package plugins

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"infinite-canvas/backend/internal/protocol"
)

// Official packages are immutable inputs shipped with the application. Cache
// their validated envelopes so multiple runtime instances do not repeatedly
// parse the same archives during startup. Uploaded packages are intentionally
// parsed through the uncached path.
var officialPluginPackageCache = struct {
	sync.RWMutex
	items map[string]protocol.PluginPackage
}{items: make(map[string]protocol.PluginPackage)}

func parseOfficialPluginPackage(data []byte) (protocol.PluginPackage, error) {
	key := pluginHash(data)
	officialPluginPackageCache.RLock()
	if pkg, ok := officialPluginPackageCache.items[key]; ok {
		officialPluginPackageCache.RUnlock()
		return pkg, nil
	}
	officialPluginPackageCache.RUnlock()
	pkg, err := protocol.ParsePluginPackage(data)
	if err != nil {
		return protocol.PluginPackage{}, err
	}
	officialPluginPackageCache.Lock()
	officialPluginPackageCache.items[key] = pkg
	officialPluginPackageCache.Unlock()
	return pkg, nil
}

func (c *Runtime) reconcileBuiltIns(stored []RegistryRecord) ([]RegistryRecord, error) {
	byID := make(map[string]RegistryRecord, len(stored))
	for _, record := range stored {
		if _, exists := byID[record.ID]; exists {
			return nil, fmt.Errorf("插件 registry 记录 ID %q 重复", record.ID)
		}
		byID[record.ID] = record
	}
	officialDir, err := officialPluginPackageDir()
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(officialDir)
	if err != nil {
		return nil, fmt.Errorf("读取官方插件目录失败：%w", err)
	}
	builtInIDs := make(map[string]struct{}, len(entries)+2)
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(strings.ToLower(entry.Name()), protocol.PluginPackageExtension) {
			continue
		}
		packageData, err := os.ReadFile(filepath.Join(officialDir, entry.Name()))
		if err != nil {
			return nil, fmt.Errorf("读取官方插件包 %s：%w", entry.Name(), err)
		}
		pkg, err := parseOfficialPluginPackage(packageData)
		if err != nil {
			return nil, fmt.Errorf("校验官方插件包 %s：%w", entry.Name(), err)
		}
		if strings.HasPrefix(strings.TrimSpace(pkg.Manifest.Runtime.Backend), "host:") {
			return nil, fmt.Errorf("官方插件 %q 不能依赖 host 执行器", pkg.Manifest.Metadata.ID)
		}
		if _, err := protocol.LoadInstalledProviders(pkg.ManifestRaw, nil); err != nil {
			return nil, fmt.Errorf("加载官方插件 %q：%w", pkg.Manifest.Metadata.ID, err)
		}
		id := pkg.Manifest.Metadata.ID
		if _, duplicate := builtInIDs[id]; duplicate {
			return nil, fmt.Errorf("官方插件 ID %q 重复", id)
		}
		builtInIDs[id] = struct{}{}
		manifest := pkg.Manifest
		record := byID[id]
		if len(record.Raw) > 0 {
			var previous protocol.Manifest
			if err := json.Unmarshal(record.Raw, &previous); err == nil {
				manifest.Metadata.Enabled = previous.Metadata.Enabled
			}
		}
		manifestData, err := json.Marshal(manifest)
		if err != nil {
			return nil, fmt.Errorf("编码官方插件 %q：%w", id, err)
		}
		hash := pluginHash(packageData)
		packageName := hash + protocol.PluginPackageExtension
		if _, err := ensurePluginBlob(filepath.Join(c.packageDir, packageName), packageData); err != nil {
			return nil, fmt.Errorf("缓存官方插件 %q：%w", id, err)
		}
		now := time.Now().UTC()
		next := RegistryRecord{
			ID: id, Raw: manifestData, Source: OriginOfficial, FileName: entry.Name(),
			PackagePath: packageName, PackageSHA256: hash, InstalledAt: now, UpdatedAt: now,
		}
		if !record.InstalledAt.IsZero() {
			next.InstalledAt = record.InstalledAt
		}
		if !registryRecordContentChanged(record, next) {
			next.UpdatedAt = record.UpdatedAt
		}
		byID[id] = next
	}
	bundledManifests := BundledWorkflowManifests()
	for _, bundled := range bundledManifests {
		builtInIDs[bundled.Metadata.ID] = struct{}{}
		data, err := json.Marshal(bundled)
		if err != nil {
			return nil, fmt.Errorf("encode built-in plugin %s: %w", bundled.Metadata.ID, err)
		}
		record := byID[bundled.Metadata.ID]
		if len(record.Raw) > 0 {
			var installed protocol.Manifest
			if err := json.Unmarshal(record.Raw, &installed); err != nil {
				return nil, fmt.Errorf("decode built-in plugin %s: %w", bundled.Metadata.ID, err)
			}
			bundled.Metadata.Enabled = installed.Metadata.Enabled
			data, err = json.Marshal(bundled)
			if err != nil {
				return nil, fmt.Errorf("encode built-in plugin %s: %w", bundled.Metadata.ID, err)
			}
		}
		now := time.Now().UTC()
		next := RegistryRecord{
			ID: bundled.Metadata.ID, Raw: data, Source: OriginOfficial,
			InstalledAt: now, UpdatedAt: now,
		}
		if !record.InstalledAt.IsZero() {
			next.InstalledAt = record.InstalledAt
		}
		if !registryRecordContentChanged(record, next) {
			next.UpdatedAt = record.UpdatedAt
		}
		byID[bundled.Metadata.ID] = next
	}
	result := make([]RegistryRecord, 0, len(byID))
	for _, record := range byID {
		if IsBuiltInSource(record.Source) {
			if _, exists := builtInIDs[record.ID]; !exists {
				// Built-in records are reconciled from repository packages and host
				// manifests on every startup, so removed plugins cannot survive stale.
				continue
			}
		}
		result = append(result, record)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].ID < result[j].ID })
	return result, nil
}
