package beefapi

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// wireID decodes JSON numbers from the enterprise API (Go int / PostgreSQL).
// The UI and local snapshot store a decimal string at the internal boundary.
type wireID string

func (id *wireID) UnmarshalJSON(raw []byte) error {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		*id = ""
		return nil
	}
	if raw[0] == '"' {
		var text string
		if err := json.Unmarshal(raw, &text); err != nil {
			return err
		}
		*id = wireID(text)
		return nil
	}
	var number json.Number
	if err := json.Unmarshal(raw, &number); err != nil {
		return fmt.Errorf("企业标识无效")
	}
	*id = wireID(number.String())
	return nil
}

func (id wireID) String() string {
	return string(id)
}

func positiveIdentity(id wireID, invalid string) (string, error) {
	raw := strings.TrimSpace(string(id))
	if raw == "" {
		return "", fmt.Errorf("%s", invalid)
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value <= 0 {
		return "", fmt.Errorf("%s", invalid)
	}
	return strconv.FormatInt(value, 10), nil
}
