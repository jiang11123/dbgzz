package app

import "infinite-canvas/backend/internal/appearance"

func defaultAppearanceSkinThemes() []AppearanceSkinTheme {
	return appearance.DefaultSkinThemes()
}

func cloneAppearanceSkin(source AppearanceSkinTheme, id, name, description string) AppearanceSkinTheme {
	return appearance.CloneSkin(source, id, name, description)
}

func normalizeAppearanceSkinThemes(themes []AppearanceSkinTheme) []AppearanceSkinTheme {
	return appearance.NormalizeSkinThemes(themes)
}
