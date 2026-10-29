package provider

import (
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
)

type InlineMediaPolicy string

const (
	InlineMediaReject      InlineMediaPolicy = "reject"
	InlineMediaLocalUpload InlineMediaPolicy = "local-upload"
)

type ConfigField struct {
	Key      string `json:"key"`
	Required bool   `json:"required,omitempty"`
	Secret   bool   `json:"secret,omitempty"`
}

type Manifest struct {
	SchemaVersion int               `json:"schemaVersion"`
	ID            string            `json:"id"`
	Version       string            `json:"version"`
	Capabilities  []string          `json:"capabilities"`
	Config        []ConfigField     `json:"config,omitempty"`
	InlineMedia   InlineMediaPolicy `json:"inlineMedia"`
}

var manifestID = regexp.MustCompile(`^[a-z0-9]+(?:[._-][a-z0-9]+)*$`)

func (m Manifest) Validate() error {
	if m.SchemaVersion != 1 {
		return errors.New("provider manifest schemaVersion must be 1")
	}
	if !manifestID.MatchString(strings.TrimSpace(m.ID)) || strings.TrimSpace(m.Version) == "" {
		return errors.New("provider manifest id or version is invalid")
	}
	allowed := []string{"text", "image", "video", "audio"}
	if len(m.Capabilities) == 0 {
		return errors.New("provider manifest needs a capability")
	}
	seen := map[string]bool{}
	for _, capability := range m.Capabilities {
		if !slices.Contains(allowed, capability) || seen[capability] {
			return fmt.Errorf("invalid provider capability %q", capability)
		}
		seen[capability] = true
	}
	if m.InlineMedia != InlineMediaReject && m.InlineMedia != InlineMediaLocalUpload {
		return errors.New("provider inline-media policy must be reject or local-upload")
	}
	for _, field := range m.Config {
		if !manifestID.MatchString(field.Key) {
			return fmt.Errorf("invalid provider config field %q", field.Key)
		}
	}
	return nil
}
