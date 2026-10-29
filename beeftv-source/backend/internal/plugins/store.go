package plugins

import (
	"encoding/json"
	"fmt"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

// RegistrySettingKey is the namespaced SystemSetting row that stores the
// committed plugin registry JSON. Production treats this row as the sole
// durable registry authority.
const RegistrySettingKey = "plugin_registry"

// RegistryCommit is the typed transactional write for registry records plus
// optional platform upsert or plugin state removal.
type RegistryCommit struct {
	Records        []RegistryRecord
	Platform       *model.PluginPlatformState
	DeletePluginID string
}

// Store is the durable plugin authority. Production mutations commit registry
// records and related platform/user-state through CommitPluginRegistry.
type Store interface {
	PluginPlatformState(pluginID string) (*model.PluginPlatformState, error)
	UserPluginState(userID, pluginID string) (*model.UserPluginState, error)
	SaveUserPluginState(state *model.UserPluginState) error
	SavePluginPlatformState(state *model.PluginPlatformState) error
	EnabledPluginUserCounts() (map[string]int64, error)
	DeletePluginStates(pluginID string) error
	LoadPluginRegistry() (records []RegistryRecord, found bool, err error)
	CommitPluginRegistry(commit RegistryCommit) error
}

type repositoryStore struct {
	repo *repository.Repository
}

func NewRepositoryStore(repo *repository.Repository) Store {
	if repo == nil {
		return nil
	}
	return repositoryStore{repo: repo}
}

func (s repositoryStore) PluginPlatformState(pluginID string) (*model.PluginPlatformState, error) {
	return s.repo.PluginPlatformState(pluginID)
}

func (s repositoryStore) UserPluginState(userID, pluginID string) (*model.UserPluginState, error) {
	return s.repo.UserPluginState(userID, pluginID)
}

func (s repositoryStore) SaveUserPluginState(state *model.UserPluginState) error {
	return s.repo.SaveUserPluginState(state)
}

func (s repositoryStore) SavePluginPlatformState(state *model.PluginPlatformState) error {
	return s.repo.SavePluginPlatformState(state)
}

func (s repositoryStore) EnabledPluginUserCounts() (map[string]int64, error) {
	return s.repo.EnabledPluginUserCounts()
}

func (s repositoryStore) DeletePluginStates(pluginID string) error {
	return s.repo.DeletePluginStates(pluginID)
}

func (s repositoryStore) LoadPluginRegistry() ([]RegistryRecord, bool, error) {
	setting, err := s.repo.LookupSystemSetting(RegistrySettingKey)
	if err != nil {
		return nil, false, err
	}
	if setting == nil {
		return nil, false, nil
	}
	records, err := decodeRegistryJSON([]byte(setting.ValueJSON))
	if err != nil {
		return nil, true, err
	}
	return records, true, nil
}

func (s repositoryStore) CommitPluginRegistry(commit RegistryCommit) error {
	data, err := json.Marshal(commit.Records)
	if err != nil {
		return fmt.Errorf("编码插件 registry：%w", err)
	}
	return s.repo.CommitPluginRegistry(RegistrySettingKey, string(data), commit.Platform, commit.DeletePluginID)
}
