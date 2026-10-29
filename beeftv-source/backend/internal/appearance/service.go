package appearance

import (
	"encoding/json"
	"errors"
	"strings"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
)

type Service struct {
	settings  SettingsStore
	resources Resources
	files     LocalFiles
	admin     AdminGate
	lock      StorageLock
}

func New(deps Dependencies) *Service {
	return &Service{
		settings:  deps.Settings,
		resources: deps.Resources,
		files:     deps.Files,
		admin:     deps.Admin,
		lock:      deps.Lock,
	}
}

func (s *Service) Public() (*PublicSetting, error) {
	setting, value, err := s.read()
	if err != nil {
		return nil, err
	}
	value = s.resolveAvailable(value)
	return publicSetting(setting, value), nil
}

func (s *Service) Admin(actor *model.User) (*AdminSetting, error) {
	if err := s.requireAdmin(actor); err != nil {
		return nil, err
	}
	setting, value, err := s.read()
	if err != nil {
		return nil, err
	}
	value = s.resolveAvailable(value)
	result := &AdminSetting{
		Setting:    value,
		Public:     *publicSetting(setting, value),
		Configured: setting != nil,
	}
	if setting != nil {
		result.UpdatedBy = setting.UpdatedBy
		result.CreatedAt = setting.CreatedAt
		result.UpdatedAt = setting.UpdatedAt
	}
	return result, nil
}

func (s *Service) Update(actor *model.User, value Setting) (*AdminSetting, error) {
	if err := s.requireAdmin(actor); err != nil {
		return nil, err
	}
	prepared, err := prepareUpdate(value)
	if err != nil {
		return nil, err
	}
	var updated *AdminSetting
	err = s.withLock(func() error {
		current, before, readErr := s.read()
		if readErr != nil {
			return readErr
		}
		for _, candidate := range []struct {
			slot       string
			resourceID string
			currentID  string
		}{
			{slot: AssetLogo, resourceID: prepared.LogoResourceID, currentID: before.LogoResourceID},
			{slot: AssetDarkLogo, resourceID: prepared.DarkLogoResourceID, currentID: before.DarkLogoResourceID},
			{slot: AssetVideo, resourceID: prepared.AuthVideoResourceID, currentID: before.AuthVideoResourceID},
			{slot: AssetPoster, resourceID: prepared.AuthVideoPosterResourceID, currentID: before.AuthVideoPosterResourceID},
		} {
			if err := s.validateResource(actor, candidate.slot, candidate.resourceID, candidate.currentID); err != nil {
				return err
			}
		}
		encoded, err := json.Marshal(prepared)
		if err != nil {
			return err
		}
		setting := model.SystemSetting{Key: SettingKey, ValueJSON: string(encoded), UpdatedBy: actor.ID}
		if current != nil {
			setting.CreatedAt = current.CreatedAt
		}
		if err := s.settings.SaveSystemSetting(&setting); err != nil {
			return err
		}
		if err := s.appendAudit(actor, "appearance.update", "system_setting", SettingKey, "更新外观配置", map[string]any{"before": before, "after": prepared}); err != nil {
			return err
		}
		result, err := s.Admin(actor)
		if err != nil {
			return err
		}
		updated = result
		return nil
	})
	if err != nil {
		return nil, err
	}
	return updated, nil
}

func (s *Service) Reset(actor *model.User) (*AdminSetting, error) {
	if err := s.requireAdmin(actor); err != nil {
		return nil, err
	}
	var reset *AdminSetting
	err := s.withLock(func() error {
		_, before, err := s.read()
		if err != nil {
			return err
		}
		if err := s.settings.DeleteSystemSetting(SettingKey); err != nil {
			return err
		}
		after := DefaultSetting()
		if err := s.appendAudit(actor, "appearance.reset", "system_setting", SettingKey, "恢复 BeefTV 默认品牌标识", map[string]any{"before": before, "after": after}); err != nil {
			return err
		}
		result, err := s.Admin(actor)
		if err != nil {
			return err
		}
		reset = result
		return nil
	})
	if err != nil {
		return nil, err
	}
	return reset, nil
}

func (s *Service) Identity() (string, string) {
	_, value, err := s.read()
	if err != nil || strings.TrimSpace(value.BrandName) == "" {
		return DefaultBrandName, DefaultBrandSlug
	}
	return value.BrandName, value.BrandSlug
}

func (s *Service) ConfiguredResource(slot string) (*model.Resource, error) {
	_, value, err := s.read()
	if err != nil {
		return nil, err
	}
	id := resourceID(value, slot)
	if id == "" {
		return nil, kernel.NotFound("未配置该外观资源")
	}
	if s.resources == nil {
		return nil, kernel.NotFound("外观资源不存在")
	}
	resource, err := s.resources.Resource(id)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, kernel.NotFound("外观资源不存在")
		}
		return nil, err
	}
	if err := validateResourceType(slot, resource); err != nil {
		return nil, err
	}
	return resource, nil
}

func (s *Service) requireAdmin(actor *model.User) error {
	if s == nil || s.admin == nil {
		return kernel.Unauthorized("请先登录")
	}
	return s.admin.RequireAdmin(actor)
}

func (s *Service) appendAudit(actor *model.User, action, targetType, targetID, summary string, metadata any) error {
	if s == nil || s.admin == nil {
		return kernel.Unauthorized("请先登录")
	}
	return s.admin.AppendAudit(actor, action, targetType, targetID, summary, metadata)
}

func (s *Service) withLock(fn func() error) error {
	if fn == nil {
		return nil
	}
	if s == nil || s.lock == nil {
		return fn()
	}
	return s.lock.WithLock(fn)
}
