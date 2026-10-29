package appearance

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
)

func (s *Service) read() (*model.SystemSetting, Setting, error) {
	if s == nil || s.settings == nil {
		return nil, Setting{}, errors.New("外观配置尚未初始化")
	}
	setting, err := s.settings.SystemSetting(SettingKey)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, DefaultSetting(), nil
	}
	if err != nil {
		return nil, Setting{}, err
	}
	value := DefaultSetting()
	if strings.TrimSpace(setting.ValueJSON) == "" || json.Unmarshal([]byte(setting.ValueJSON), &value) != nil {
		return nil, Setting{}, errors.New("外观配置格式无效")
	}
	return setting, normalizeDocument(value), nil
}

func normalizeDocument(value Setting) Setting {
	value.SchemaVersion = SchemaVersion
	value.BrandName = strings.TrimSpace(value.BrandName)
	if value.BrandName == "" {
		value.BrandName = DefaultBrandName
	}
	value.BrandSlug = strings.ToLower(strings.TrimSpace(value.BrandSlug))
	if value.BrandSlug == "" {
		value.BrandSlug = DefaultBrandSlug
	}
	value.AuthHeroTitle = normalizeCopy(value.AuthHeroTitle)
	if value.AuthHeroTitle == "" {
		value.AuthHeroTitle = DefaultHeroTitle
	}
	value.AuthHeroDescription = normalizeCopy(value.AuthHeroDescription)
	value.SkinID = strings.TrimSpace(value.SkinID)
	if value.SkinID == "" {
		value.SkinID = DefaultSkinID
	}
	if len(value.SkinThemes) == 0 {
		value.SkinThemes = DefaultSkinThemes()
	}
	value.SkinThemes = NormalizeSkinThemes(value.SkinThemes)
	value.SEOTitle = normalizeSingleLine(value.SEOTitle)
	value.SEODescription = normalizeCopy(value.SEODescription)
	value.SEOKeywords = normalizeSingleLine(value.SEOKeywords)
	value.FooterCopyright = normalizeSingleLine(value.FooterCopyright)
	value.ICPFilingNumber = normalizeSingleLine(value.ICPFilingNumber)
	return value
}

func prepareUpdate(value Setting) (Setting, error) {
	value.SchemaVersion = SchemaVersion
	value.BrandName = strings.TrimSpace(value.BrandName)
	value.BrandSlug = strings.ToLower(strings.TrimSpace(value.BrandSlug))
	value.AuthHeroTitle = normalizeCopy(value.AuthHeroTitle)
	value.AuthHeroDescription = normalizeCopy(value.AuthHeroDescription)
	value.LogoResourceID = strings.TrimSpace(value.LogoResourceID)
	value.DarkLogoResourceID = strings.TrimSpace(value.DarkLogoResourceID)
	value.AuthVideoResourceID = strings.TrimSpace(value.AuthVideoResourceID)
	value.AuthVideoPosterResourceID = strings.TrimSpace(value.AuthVideoPosterResourceID)
	value.SkinID = strings.TrimSpace(value.SkinID)
	if len(value.SkinThemes) == 0 {
		value.SkinThemes = DefaultSkinThemes()
	}
	value.SkinThemes = NormalizeSkinThemes(value.SkinThemes)
	value.SEOTitle = normalizeSingleLine(value.SEOTitle)
	value.SEODescription = normalizeCopy(value.SEODescription)
	value.SEOKeywords = normalizeSingleLine(value.SEOKeywords)
	value.FooterCopyright = normalizeSingleLine(value.FooterCopyright)
	value.ICPFilingNumber = normalizeSingleLine(value.ICPFilingNumber)
	if err := validateSetting(value); err != nil {
		return Setting{}, err
	}
	return value, nil
}

func validateSetting(value Setting) error {
	if value.BrandName == "" || utf8.RuneCountInString(value.BrandName) > 40 {
		return kernel.BadAuthRequest("品牌名称必须为 1 到 40 个字符")
	}
	for _, char := range value.BrandName {
		if unicode.IsControl(char) {
			return kernel.BadAuthRequest("品牌名称不能包含控制字符")
		}
	}
	if !validBrandSlug(value.BrandSlug) {
		return kernel.BadAuthRequest("英文品牌标识须为 1 到 48 位小写字母、数字或连字符，且不能以连字符开头或结尾")
	}
	if err := validateCopy(value.AuthHeroTitle, "登录页主标题", 80, true); err != nil {
		return err
	}
	if err := validateCopy(value.AuthHeroDescription, "登录页说明文案", 160, false); err != nil {
		return err
	}
	if err := validateAppearanceSkinThemes(value.SkinThemes, value.SkinID); err != nil {
		return err
	}
	for _, field := range []struct {
		value string
		label string
		max   int
	}{
		{value.SEOTitle, "SEO 标题", 70},
		{value.SEODescription, "SEO 描述", 200},
		{value.SEOKeywords, "SEO 关键词", 300},
		{value.FooterCopyright, "版权信息", 160},
		{value.ICPFilingNumber, "备案号", 64},
	} {
		if err := validateCopy(field.value, field.label, field.max, false); err != nil {
			return err
		}
	}
	if value.ICPFilingEnabled && value.ICPFilingNumber == "" {
		return kernel.BadAuthRequest("显示备案号前请先填写备案号")
	}
	for _, resourceID := range []string{value.LogoResourceID, value.DarkLogoResourceID, value.AuthVideoResourceID, value.AuthVideoPosterResourceID} {
		if len(resourceID) > 80 {
			return kernel.BadAuthRequest("外观资源 ID 无效")
		}
	}
	return nil
}

func normalizeCopy(value string) string {
	return strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(value, "\r\n", "\n"), "\r", "\n"))
}

func normalizeSingleLine(value string) string {
	return strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(value, "\r\n", " "), "\r", " "))
}

func validBrandSlug(value string) bool {
	if len(value) == 0 || len(value) > 48 || value[0] == '-' || value[len(value)-1] == '-' {
		return false
	}
	for _, char := range value {
		if (char < 'a' || char > 'z') && (char < '0' || char > '9') && char != '-' {
			return false
		}
	}
	return true
}

func validateCopy(value string, label string, maxRunes int, required bool) error {
	if required && value == "" {
		return kernel.BadAuthRequest(label + "不能为空")
	}
	if utf8.RuneCountInString(value) > maxRunes {
		return kernel.BadAuthRequest(fmt.Sprintf("%s不能超过 %d 个字符", label, maxRunes))
	}
	for _, char := range value {
		if unicode.IsControl(char) && char != '\n' {
			return kernel.BadAuthRequest(label + "不能包含控制字符")
		}
	}
	return nil
}

func resourceID(value Setting, slot string) string {
	switch slot {
	case AssetLogo:
		return value.LogoResourceID
	case AssetDarkLogo:
		return value.DarkLogoResourceID
	case AssetVideo:
		return value.AuthVideoResourceID
	case AssetPoster:
		return value.AuthVideoPosterResourceID
	default:
		return ""
	}
}

func referencedIDs(value Setting) []string {
	return []string{
		value.LogoResourceID,
		value.DarkLogoResourceID,
		value.AuthVideoResourceID,
		value.AuthVideoPosterResourceID,
	}
}
