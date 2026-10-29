package canvas

import (
	"encoding/json"

	"infinite-canvas/backend/internal/asset"
	"infinite-canvas/backend/internal/model"
)

func ClientAssetPayload(item model.Asset) json.RawMessage {
	return asset.ClientAssetPayload(item)
}
