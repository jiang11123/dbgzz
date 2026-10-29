package plugins

import (
	"encoding/json"
	"strings"
	"time"

	"infinite-canvas/backend/internal/protocol"
)

// View is the backend representation consumed by the single frontend plugin
// center. Protocol-specific runtime data stays nested under Manifest so the
// public plugin contract can grow without adding another center API.
type View struct {
	Manifest    ManifestView   `json:"manifest"`
	Source      string         `json:"source"`
	FileName    string         `json:"fileName"`
	Package     string         `json:"package"`
	SHA256      string         `json:"sha256"`
	InstalledAt time.Time      `json:"installedAt"`
	UpdatedAt   time.Time      `json:"updatedAt"`
	Status      string         `json:"status"`
	Error       string         `json:"error,omitempty"`
	Management  ManagementView `json:"management"`
}

type ManifestView struct {
	APIVersion    string                         `json:"apiVersion"`
	ID            string                         `json:"id"`
	Name          string                         `json:"name"`
	Version       string                         `json:"version"`
	Entry         string                         `json:"entry,omitempty"`
	Surfaces      []string                       `json:"surfaces,omitempty"`
	Description   string                         `json:"description,omitempty"`
	Documentation string                         `json:"documentation,omitempty"`
	Author        string                         `json:"author,omitempty"`
	Permissions   []string                       `json:"permissions"`
	Trusted       bool                           `json:"trusted"`
	Runtime       protocol.ManifestRuntime       `json:"runtime,omitempty"`
	Configuration protocol.ManifestConfiguration `json:"configuration,omitempty"`
	Contributes   protocol.ManifestContributions `json:"contributes"`
}

// ManagementView is computed by the host. Uploaded manifests cannot choose
// their own privilege or activation scope.
type ManagementView struct {
	Origin             string `json:"origin"`
	Kind               string `json:"kind"`
	ActivationScope    string `json:"activationScope"`
	ConfigurationScope string `json:"configurationScope"`
}

type StateView struct {
	PluginID          string `json:"pluginId"`
	PlatformAvailable bool   `json:"platformAvailable"`
	UserEnabled       bool   `json:"userEnabled"`
	UserConfigured    bool   `json:"userConfigured"`
	EffectiveEnabled  bool   `json:"effectiveEnabled"`
	CanToggle         bool   `json:"canToggle"`
	CanConfigure      bool   `json:"canConfigure"`
	BlockedReason     string `json:"blockedReason,omitempty"`
}

type AdminStateView struct {
	StateView
	EnabledUserCount int64 `json:"enabledUserCount"`
}

// Record is the in-memory installed plugin snapshot owned by Runtime.
type Record struct {
	Raw           []byte
	Metadata      protocol.Metadata
	Source        string
	FileName      string
	PackagePath   string
	PackageSHA256 string
	SHA256        string
	InstalledAt   time.Time
	UpdatedAt     time.Time
	Status        string
	Error         string
}

// RegistryRecord is the committed plugin registry row. Production stores it
// in SystemSetting plugin_registry; plugin_registry.json is a one-time import.
type RegistryRecord struct {
	ID            string          `json:"id"`
	Raw           json.RawMessage `json:"manifest"`
	Source        string          `json:"source"`
	FileName      string          `json:"fileName,omitempty"`
	PackagePath   string          `json:"packagePath,omitempty"`
	PackageSHA256 string          `json:"packageSha256,omitempty"`
	InstalledAt   time.Time       `json:"installedAt"`
	UpdatedAt     time.Time       `json:"updatedAt"`
}

func manifestView(raw []byte, metadata protocol.Metadata, source string) ManifestView {
	var manifest protocol.Manifest
	_ = json.Unmarshal(raw, &manifest)
	if manifest.Metadata.ID == "" {
		manifest.Metadata = metadata
	}
	return ManifestView{
		ID: metadata.ID, Name: metadata.Name, Version: metadata.Version, APIVersion: "beeftv.plugin/v1", Entry: manifest.Entry, Surfaces: manifest.Surfaces,
		Description: metadata.Description, Documentation: metadata.Documentation, Author: metadata.Vendor,
		Permissions: manifest.Permissions, Trusted: IsBuiltInSource(source), Runtime: manifest.Runtime,
		Configuration: manifest.Configuration, Contributes: manifest.Contributes,
	}
}

func viewFromRecord(item Record) View {
	return View{
		Manifest:    manifestView(item.Raw, item.Metadata, item.Source),
		Source:      item.Source,
		FileName:    item.FileName,
		Package:     protocol.PluginPackageFormat,
		SHA256:      item.SHA256,
		InstalledAt: item.InstalledAt,
		UpdatedAt:   item.UpdatedAt,
		Status:      item.Status,
		Error:       item.Error,
	}
}

func clonePluginView(view View) View {
	data, err := json.Marshal(view.Manifest)
	if err != nil {
		return sanitizedPluginView(view)
	}
	var manifest ManifestView
	if err := json.Unmarshal(data, &manifest); err != nil {
		return sanitizedPluginView(view)
	}
	view.Manifest = manifest
	return view
}

func sanitizedPluginView(view View) View {
	view.Manifest.Surfaces = cloneStringSlice(view.Manifest.Surfaces)
	view.Manifest.Permissions = cloneStringSlice(view.Manifest.Permissions)
	view.Manifest.Runtime = protocol.ManifestRuntime{}
	view.Manifest.Configuration = protocol.ManifestConfiguration{}
	view.Manifest.Contributes = protocol.ManifestContributions{}
	if strings.TrimSpace(view.Error) == "" {
		view.Error = "插件清单无法展示"
	}
	return view
}

func cloneStringSlice(values []string) []string {
	if values == nil {
		return nil
	}
	out := make([]string, len(values))
	copy(out, values)
	return out
}
