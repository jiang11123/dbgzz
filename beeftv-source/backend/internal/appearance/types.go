package appearance

import "time"

const SettingKey = "appearance"

const (
	AssetLogo     = "logo"
	AssetDarkLogo = "logo-dark"
	AssetVideo    = "video"
	AssetPoster   = "poster"
)

const (
	SchemaVersion        = 7
	logoMaxBytes   int64 = 5 << 20
	posterMaxBytes int64 = 10 << 20
	videoMaxBytes  int64 = 256 << 20
)

const (
	DefaultBrandName = "豆奶画布"
	DefaultBrandSlug = "beeftv"
	DefaultSkinID    = "classic"
	DefaultLogoURL   = "/logo.svg"
	DefaultVideoURL  = "https://boss-shjd.biliapi.net/updream/aniforge/video/video_bbcb00bd-650d-4249-9346-5cd21fd2484c_m1hc-u0-1pu13x-3v1s.mp4"
	DefaultPosterURL = "https://i0.hdslb.com/bfs/aitool/aniforge/image/02933f26-5f1b-49ff-a811-b7f95ee5e5b8_m1hc-u0-sau.jpg"
	DefaultHeroTitle = "让一个故事，\n从文字走向银幕。"
)

type Setting struct {
	SchemaVersion             int                   `json:"schemaVersion"`
	BrandName                 string                `json:"brandName"`
	BrandSlug                 string                `json:"brandSlug"`
	AuthHeroTitle             string                `json:"authHeroTitle"`
	AuthHeroDescription       string                `json:"authHeroDescription"`
	LogoResourceID            string                `json:"logoResourceId"`
	DarkLogoResourceID        string                `json:"darkLogoResourceId"`
	LogoFrameEnabled          bool                  `json:"logoFrameEnabled"`
	AuthVideoResourceID       string                `json:"authVideoResourceId"`
	AuthVideoPosterResourceID string                `json:"authVideoPosterResourceId"`
	AuthVideoAutoplay         bool                  `json:"authVideoAutoplay"`
	SkinID                    string                `json:"skinId"`
	SkinThemes                []AppearanceSkinTheme `json:"skinThemes"`
	SEOTitle                  string                `json:"seoTitle"`
	SEODescription            string                `json:"seoDescription"`
	SEOKeywords               string                `json:"seoKeywords"`
	FooterCopyright           string                `json:"footerCopyright"`
	ICPFilingEnabled          bool                  `json:"icpFilingEnabled"`
	ICPFilingNumber           string                `json:"icpFilingNumber"`
}

type PublicSetting struct {
	SchemaVersion             int                 `json:"schemaVersion"`
	BrandName                 string              `json:"brandName"`
	BrandSlug                 string              `json:"brandSlug"`
	AuthHeroTitle             string              `json:"authHeroTitle"`
	AuthHeroDescription       string              `json:"authHeroDescription"`
	LogoURL                   string              `json:"logoUrl"`
	DarkLogoURL               string              `json:"darkLogoUrl"`
	LogoFrameEnabled          bool                `json:"logoFrameEnabled"`
	AuthVideoURL              string              `json:"authVideoUrl"`
	AuthVideoPosterURL        string              `json:"authVideoPosterUrl"`
	AuthVideoAutoplay         bool                `json:"authVideoAutoplay"`
	SkinID                    string              `json:"skinId"`
	ActiveSkin                AppearanceSkinTheme `json:"activeSkin"`
	SEOTitle                  string              `json:"seoTitle"`
	SEODescription            string              `json:"seoDescription"`
	SEOKeywords               string              `json:"seoKeywords"`
	FooterCopyright           string              `json:"footerCopyright"`
	ICPFilingEnabled          bool                `json:"icpFilingEnabled"`
	ICPFilingNumber           string              `json:"icpFilingNumber"`
	LogoConfigured            bool                `json:"logoConfigured"`
	DarkLogoConfigured        bool                `json:"darkLogoConfigured"`
	AuthVideoConfigured       bool                `json:"authVideoConfigured"`
	AuthVideoPosterConfigured bool                `json:"authVideoPosterConfigured"`
	Configured                bool                `json:"configured"`
	Revision                  string              `json:"revision"`
	UpdatedAt                 time.Time           `json:"updatedAt,omitempty"`
}

type AdminSetting struct {
	Setting
	Public     PublicSetting `json:"public"`
	Configured bool          `json:"configured"`
	UpdatedBy  string        `json:"updatedBy,omitempty"`
	CreatedAt  time.Time     `json:"createdAt,omitempty"`
	UpdatedAt  time.Time     `json:"updatedAt,omitempty"`
}

func DefaultSetting() Setting {
	return Setting{
		SchemaVersion:     SchemaVersion,
		BrandName:         DefaultBrandName,
		BrandSlug:         DefaultBrandSlug,
		AuthHeroTitle:     DefaultHeroTitle,
		AuthVideoAutoplay: true,
		LogoFrameEnabled:  true,
		SkinID:            DefaultSkinID,
		SkinThemes:        DefaultSkinThemes(),
	}
}
