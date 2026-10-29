package canvas

import (
	"encoding/json"
	"testing"
)

func TestUserAssetBytesRequiresNonNegativeNumber(t *testing.T) {
	for _, kind := range []string{"image", "video", "audio", "model"} {
		for _, raw := range []string{"null", " null ", `"12"`, "-1", "true", "{}", "[]", "1e400", "0", "12"} {
			t.Run(kind+"/"+raw, func(t *testing.T) {
				encoded, err := marshalAssetWithRawBytes(kind, raw)
				if err != nil {
					t.Fatal(err)
				}
				err = validateUserAssetDocument(encoded)
				valid := raw == "0" || raw == "12"
				if (err == nil) != valid {
					t.Fatalf("bytes=%s: error=%v, want valid=%v", raw, err, valid)
				}
				encoded, err = marshalAssetWithRawBytes(kind, "")
				if err != nil {
					t.Fatal(err)
				}
				if err := validateUserAssetDocument(encoded); err == nil {
					t.Fatal("missing bytes accepted")
				}
			})
		}
	}
}

func marshalAssetWithRawBytes(kind, bytesRaw string) (json.RawMessage, error) {
	data := map[string]json.RawMessage{
		"dataUrl": json.RawMessage(`"https://example.com/file"`),
		"url":     json.RawMessage(`"https://example.com/file"`),
		"width":   json.RawMessage("1"), "height": json.RawMessage("1"),
		"mimeType": json.RawMessage(`"application/octet-stream"`),
		"fileName": json.RawMessage(`"file.glb"`),
	}
	if bytesRaw != "" {
		data["bytes"] = json.RawMessage(bytesRaw)
	}
	dataJSON, err := json.Marshal(data)
	if err != nil {
		return nil, err
	}
	object := map[string]json.RawMessage{
		"kind":     json.RawMessage(`"` + kind + `"`),
		"title":    json.RawMessage(`"测试"`),
		"coverUrl": json.RawMessage(`""`),
		"tags":     json.RawMessage(`[]`),
		"data":     dataJSON,
	}
	return json.Marshal(object)
}
