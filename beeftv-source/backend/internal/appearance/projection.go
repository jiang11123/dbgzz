package appearance

import (
	"fmt"
	"net/url"
	"strconv"
	"time"

	"infinite-canvas/backend/internal/model"
)

func publicSetting(setting *model.SystemSetting, value Setting) *PublicSetting {
	revision := "builtin"
	if setting != nil {
		revision = strconv.FormatInt(setting.UpdatedAt.UTC().UnixNano(), 36)
	}
	result := &PublicSetting{
		SchemaVersion:       SchemaVersion,
		BrandName:           value.BrandName,
		BrandSlug:           value.BrandSlug,
		AuthHeroTitle:       value.AuthHeroTitle,
		AuthHeroDescription: value.AuthHeroDescription,
		LogoURL:             DefaultLogoURL,
		DarkLogoURL:         DefaultLogoURL,
		LogoFrameEnabled:    value.LogoFrameEnabled,
		AuthVideoURL:        DefaultVideoURL,
		AuthVideoPosterURL:  DefaultPosterURL,
		AuthVideoAutoplay:   value.AuthVideoAutoplay,
		SkinID:              value.SkinID,
		ActiveSkin:          activeAppearanceSkin(value.SkinThemes, value.SkinID),
		SEOTitle:            effectiveSEOTitle(value),
		SEODescription:      effectiveSEODescription(value),
		SEOKeywords:         value.SEOKeywords,
		FooterCopyright:     effectiveCopyright(value),
		ICPFilingEnabled:    value.ICPFilingEnabled && value.ICPFilingNumber != "",
		ICPFilingNumber:     value.ICPFilingNumber,
		Configured:          setting != nil,
		Revision:            revision,
	}
	if setting != nil {
		result.UpdatedAt = setting.UpdatedAt
	}
	if value.LogoResourceID != "" || value.DarkLogoResourceID != "" {
		result.LogoConfigured = true
		if value.LogoResourceID != "" {
			result.LogoURL = assetURL(AssetLogo, revision)
		} else {
			result.LogoURL = assetURL(AssetDarkLogo, revision)
		}
		if value.DarkLogoResourceID != "" {
			result.DarkLogoConfigured = true
			result.DarkLogoURL = assetURL(AssetDarkLogo, revision)
		} else {
			result.DarkLogoURL = result.LogoURL
		}
		if value.LogoResourceID == "" {
			result.LogoURL = result.DarkLogoURL
		}
	}
	if value.AuthVideoResourceID != "" {
		result.AuthVideoConfigured = true
		result.AuthVideoURL = assetURL(AssetVideo, revision)
		if value.AuthVideoPosterResourceID == "" {
			result.AuthVideoPosterURL = ""
		}
	}
	if value.AuthVideoPosterResourceID != "" {
		result.AuthVideoPosterConfigured = true
		result.AuthVideoPosterURL = assetURL(AssetPoster, revision)
	}
	return result
}

func effectiveSEOTitle(value Setting) string {
	if value.SEOTitle != "" {
		return value.SEOTitle
	}
	return value.BrandName
}

func effectiveSEODescription(value Setting) string {
	if value.SEODescription != "" {
		return value.SEODescription
	}
	return value.BrandName + "，面向 AI 影视与短剧创作的工作台。"
}

func effectiveCopyright(value Setting) string {
	if value.FooterCopyright != "" {
		return value.FooterCopyright
	}
	return fmt.Sprintf("© %d %s. All rights reserved.", time.Now().Year(), value.BrandName)
}

func assetURL(slot string, revision string) string {
	return "/api/public/appearance/assets/" + url.PathEscape(slot) + "?v=" + url.QueryEscape(revision)
}
