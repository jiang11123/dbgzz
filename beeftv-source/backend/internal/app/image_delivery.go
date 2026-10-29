package app

import (
	"encoding/json"
	"strings"

	"infinite-canvas/backend/internal/model"
)

// Keep only the encrypted download configuration until URL outputs have been
// materialized. Public task projections omit this field, and delivery removes
// it after all outputs commit. Reference bytes and prompts are never retained.
func (s *Service) completionInputJSON(task model.Task, resultJSON []byte) (string, error) {
	public := publicTaskInputJSON(task.InputJSON)
	if task.Type != "canvas_image" {
		return public, nil
	}
	var result struct {
		Images []struct {
			URL     string `json:"url"`
			DataURL string `json:"dataUrl"`
		} `json:"images"`
	}
	if err := json.Unmarshal(resultJSON, &result); err != nil {
		return "", err
	}
	remote := false
	for _, image := range result.Images {
		remote = remote || strings.HasPrefix(image.URL, "https://") || strings.HasPrefix(image.URL, "http://")
		remote = remote || strings.HasPrefix(image.DataURL, "https://") || strings.HasPrefix(image.DataURL, "http://")
	}
	if !remote {
		return public, nil
	}
	plain, err := s.decryptTaskInputJSON(task.InputJSON)
	if err != nil {
		return "", err
	}
	var input map[string]json.RawMessage
	if err := json.Unmarshal([]byte(plain), &input); err != nil {
		return "", err
	}
	if len(input["config"]) == 0 {
		return public, nil
	}
	var original map[string]json.RawMessage
	if err := json.Unmarshal(input["config"], &original); err != nil {
		return "", err
	}
	config := map[string]json.RawMessage{}
	for _, key := range []string{"channelId", "channelModelKey", "providerModelKey", "variantId", "apiFormat", "interfaceType", "baseUrl", "apiKey", "secretKey", "headers", "credentialRef", "model"} {
		if value, ok := original[key]; ok {
			config[key] = value
		}
	}
	configJSON, err := json.Marshal(config)
	if err != nil {
		return "", err
	}
	cipher, err := s.encryptSettingSecret(string(configJSON))
	if err != nil {
		return "", err
	}
	payload := map[string]any{}
	if public != "" {
		if err := json.Unmarshal([]byte(public), &payload); err != nil {
			return "", err
		}
	}
	payload["imageDeliveryCipher"] = cipher
	encoded, err := json.Marshal(payload)
	return string(encoded), err
}
