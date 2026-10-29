package appearance

import "infinite-canvas/backend/internal/model"

type SettingsStore interface {
	SystemSetting(key string) (*model.SystemSetting, error)
	SaveSystemSetting(*model.SystemSetting) error
	DeleteSystemSetting(key string) error
}

type Resources interface {
	Resource(id string) (*model.Resource, error)
}

type LocalFiles interface {
	Exists(objectKey string) bool
}

type AdminGate interface {
	RequireAdmin(user *model.User) error
	AppendAudit(actor *model.User, action, targetType, targetID, summary string, metadata any) error
}

type StorageLock interface {
	WithLock(func() error) error
}

type Dependencies struct {
	Settings  SettingsStore
	Resources Resources
	Files     LocalFiles
	Admin     AdminGate
	Lock      StorageLock
}
