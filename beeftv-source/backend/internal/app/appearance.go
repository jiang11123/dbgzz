package app

import (
	"mime/multipart"
	"os"
	"path/filepath"

	"infinite-canvas/backend/internal/appearance"
	"infinite-canvas/backend/internal/model"
)

const appearanceSettingKey = appearance.SettingKey

const (
	AppearanceAssetLogo     = appearance.AssetLogo
	AppearanceAssetDarkLogo = appearance.AssetDarkLogo
	AppearanceAssetVideo    = appearance.AssetVideo
	AppearanceAssetPoster   = appearance.AssetPoster
)

const (
	appearanceSchemaVersion    = appearance.SchemaVersion
	defaultAppearanceBrandName = appearance.DefaultBrandName
	defaultAppearanceBrandSlug = appearance.DefaultBrandSlug
	defaultAppearanceSkinID    = appearance.DefaultSkinID
	defaultAppearanceLogoURL   = appearance.DefaultLogoURL
	defaultAppearanceVideoURL  = appearance.DefaultVideoURL
	defaultAppearancePosterURL = appearance.DefaultPosterURL
	defaultAppearanceHeroTitle = appearance.DefaultHeroTitle
)

type AppearanceSetting = appearance.Setting
type PublicAppearanceSetting = appearance.PublicSetting
type AdminAppearanceSetting = appearance.AdminSetting
type AppearanceSkinTheme = appearance.AppearanceSkinTheme
type AppearanceSkinModeTokens = appearance.AppearanceSkinModeTokens
type AppearanceSkinTokens = appearance.AppearanceSkinTokens
type AppearanceSkinComponentTokens = appearance.AppearanceSkinComponentTokens

func AppearanceAssetMaxBytes(slot string) (int64, error) {
	return appearance.AssetMaxBytes(slot)
}

func validateAppearanceUpload(slot string, header *multipart.FileHeader) (string, error) {
	return appearance.ValidateUpload(slot, header)
}

func defaultAppearanceSetting() AppearanceSetting {
	return appearance.DefaultSetting()
}

type appearanceAdminGate struct {
	requireAdmin func(*model.User) error
	appendAudit  func(*model.User, string, string, string, string, any) error
}

func (g appearanceAdminGate) RequireAdmin(user *model.User) error {
	if g.requireAdmin == nil {
		return Unauthorized("请先登录")
	}
	return g.requireAdmin(user)
}

func (g appearanceAdminGate) AppendAudit(actor *model.User, action, targetType, targetID, summary string, metadata any) error {
	if g.appendAudit == nil {
		return Unauthorized("请先登录")
	}
	return g.appendAudit(actor, action, targetType, targetID, summary, metadata)
}

type appearanceFiles struct {
	dataDir string
}

func (f appearanceFiles) Exists(objectKey string) bool {
	if f.dataDir == "" {
		return false
	}
	info, err := os.Stat(filepath.Join(f.dataDir, "resources", filepath.FromSlash(objectKey)))
	return err == nil && !info.IsDir()
}

type appearanceLock struct {
	svc *Service
}

func (l appearanceLock) WithLock(fn func() error) error {
	if fn == nil {
		return nil
	}
	if l.svc == nil {
		return fn()
	}
	l.svc.storageMu.Lock()
	defer l.svc.storageMu.Unlock()
	return fn()
}

func (s *Service) AppearanceDomain() *appearance.Service {
	if s == nil {
		return appearance.New(appearance.Dependencies{})
	}
	s.appearanceOnce.Do(func() {
		s.appearance = appearance.New(appearance.Dependencies{
			Settings:  s.repo,
			Resources: s.repo,
			Files:     appearanceFiles{dataDir: s.dataDir},
			Admin:     appearanceAdminGate{requireAdmin: s.RequireAdmin, appendAudit: s.appendAdminAudit},
			Lock:      appearanceLock{svc: s},
		})
	})
	return s.appearance
}

func (s *Service) Appearance() (*PublicAppearanceSetting, error) {
	return s.AppearanceDomain().Public()
}

func (s *Service) AdminAppearance(actor *model.User) (*AdminAppearanceSetting, error) {
	return s.AppearanceDomain().Admin(actor)
}

func (s *Service) UpdateAppearance(actor *model.User, value AppearanceSetting) (*AdminAppearanceSetting, error) {
	return s.AppearanceDomain().Update(actor, value)
}

func (s *Service) ResetAppearance(actor *model.User) (*AdminAppearanceSetting, error) {
	return s.AppearanceDomain().Reset(actor)
}

func (s *Service) UploadAppearanceAsset(actor *model.User, slot string, header *multipart.FileHeader) (*model.Resource, error) {
	if err := s.RequireAdmin(actor); err != nil {
		return nil, err
	}
	mimeType, err := appearance.ValidateUpload(slot, header)
	if err != nil {
		return nil, err
	}
	header.Header.Set("Content-Type", mimeType)
	kind := "image"
	if slot == AppearanceAssetVideo {
		kind = "video"
	}
	var resource *model.Resource
	if slot == AppearanceAssetLogo || slot == AppearanceAssetDarkLogo {
		resource, err = s.uploadLocalResource(actor.ID, header, kind, 0, 0, 0)
	} else {
		resource, err = s.UploadResource(actor.ID, header, kind, 0, 0, 0)
	}
	if err != nil {
		return nil, err
	}
	resource.PublicURL = ""
	return resource, nil
}

func (s *Service) OpenAppearanceAsset(slot string, rangeHeader string) (*ResourceStream, error) {
	resource, err := s.AppearanceDomain().ConfiguredResource(slot)
	if err != nil {
		return nil, err
	}
	return s.openResourceRange(resource.UserID, resource, rangeHeader)
}

func (s *Service) appearanceReferencedResourceIDs(resourceIDs []string) map[string]struct{} {
	return s.AppearanceDomain().ReferencedIDs(resourceIDs)
}

func (s *Service) appearanceBrandName() string {
	brandName, _ := s.appearanceIdentity()
	return brandName
}

func (s *Service) appearanceIdentity() (string, string) {
	return s.AppearanceDomain().Identity()
}
