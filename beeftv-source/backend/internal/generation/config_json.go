package generation

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// Capability options are typed JSON, while provider controls use strings.
// Accept their scalar forms here too so already-persisted tasks can be retried.
// Credentials, model identities and structured configuration remain strict.
func (c *Config) UnmarshalJSON(data []byte) error {
	type plain Config
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return nil
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	for _, key := range []string{"transparentBackground", "videoGenerateAudio", "videoWatermark", "videoArkPrivateAssetUpload", "count", "videoSeconds", "audioSpeed"} {
		raw, ok := fields[key]
		raw = bytes.TrimSpace(raw)
		if !ok || string(raw) == "null" {
			continue
		}
		var value any
		if err := json.Unmarshal(raw, &value); err != nil {
			return err
		}
		switch value.(type) {
		case string:
			continue
		case bool:
			if key != "transparentBackground" && key != "videoGenerateAudio" && key != "videoWatermark" && key != "videoArkPrivateAssetUpload" {
				return fmt.Errorf("invalid scalar type for %s", key)
			}
		case float64:
			if key != "count" && key != "videoSeconds" && key != "audioSpeed" {
				return fmt.Errorf("invalid scalar type for %s", key)
			}
		default:
			return fmt.Errorf("invalid scalar type for %s", key)
		}
		fields[key], _ = json.Marshal(string(raw))
	}
	normalized, err := json.Marshal(fields)
	if err != nil {
		return err
	}
	decoded := plain(*c)
	if err := json.Unmarshal(normalized, &decoded); err != nil {
		return err
	}
	*c = Config(decoded)
	return nil
}
