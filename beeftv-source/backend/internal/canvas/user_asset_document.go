package canvas

import (
	"encoding/json"

	"infinite-canvas/backend/internal/asset"
)

func validateUserAssetDocument(raw json.RawMessage) error {
	return asset.ValidateDocument(raw)
}
