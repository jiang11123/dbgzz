package modelcatalog

import "infinite-canvas/backend/internal/canvas/capability"

func GenerationModeSupported(mode string) bool {
	return capability.BuiltinRegistry().SupportsGenerationMode(normalizeCapability(mode))
}
