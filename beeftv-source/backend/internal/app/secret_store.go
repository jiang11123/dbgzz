package app

import (
	"encoding/json"
	"infinite-canvas/backend/internal/localcrypto"
	"strings"
)

const encryptedSettingPrefix = localcrypto.Prefix

// encryptSettingSecret protects provider credentials before they enter task
// payloads or local configuration. It is deliberately independent from any
// hosted storage or account setting.
func (s *Service) encryptSettingSecret(value string) (string, error) {
	return localcrypto.Encrypt(s.dataDir, value)
}

func (s *Service) decryptSettingSecret(value string) (string, error) {
	if !strings.HasPrefix(value, encryptedSettingPrefix) {
		return value, nil
	}
	return localcrypto.Decrypt(s.dataDir, value)
}

func (s *Service) settingsEncryptionKey() ([]byte, error) {
	return localcrypto.Key(s.dataDir)
}

func (s *Service) protectTaskSecrets(value interface{}) error {
	switch item := value.(type) {
	case map[string]interface{}:
		for key, child := range item {
			if key == "headers" {
				if err := transformTaskHeaderSecrets(child, s.encryptSettingSecret, false); err != nil {
					return err
				}
				continue
			}
			if isTaskSecretField(key) {
				secret, _ := child.(string)
				if secret != "" && secret != "system" && !strings.HasPrefix(secret, encryptedSettingPrefix) {
					encrypted, err := s.encryptSettingSecret(secret)
					if err != nil {
						return err
					}
					item[key] = encrypted
				}
				continue
			}
			if err := s.protectTaskSecrets(child); err != nil {
				return err
			}
		}
	case []interface{}:
		for _, child := range item {
			if err := s.protectTaskSecrets(child); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *Service) decryptTaskInputJSON(raw string) (string, error) {
	if strings.TrimSpace(raw) == "" || !strings.Contains(raw, encryptedSettingPrefix) {
		return raw, nil
	}
	var input interface{}
	if err := json.Unmarshal([]byte(raw), &input); err != nil {
		return "", err
	}
	if err := s.decryptTaskSecrets(input); err != nil {
		return "", err
	}
	encoded, err := json.Marshal(input)
	return string(encoded), err
}

func (s *Service) decryptTaskSecrets(value interface{}) error {
	switch item := value.(type) {
	case map[string]interface{}:
		for key, child := range item {
			if key == "headers" {
				if err := transformTaskHeaderSecrets(child, s.decryptSettingSecret, true); err != nil {
					return err
				}
				continue
			}
			if isTaskSecretField(key) {
				secret, _ := child.(string)
				if strings.HasPrefix(secret, encryptedSettingPrefix) {
					plain, err := s.decryptSettingSecret(secret)
					if err != nil {
						return err
					}
					item[key] = plain
				}
				continue
			}
			if err := s.decryptTaskSecrets(child); err != nil {
				return err
			}
		}
	case []interface{}:
		for _, child := range item {
			if err := s.decryptTaskSecrets(child); err != nil {
				return err
			}
		}
	}
	return nil
}

func isTaskSecretField(key string) bool {
	switch key {
	case "apiKey", "secretKey", "runningHubWalletApiKey", "runningHubUploadApiKey":
		return true
	default:
		return false
	}
}

func transformTaskHeaderSecrets(value any, transform func(string) (string, error), decrypt bool) error {
	headers, _ := value.([]any)
	for _, raw := range headers {
		header, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		text, _ := header["value"].(string)
		if text == "" || strings.HasPrefix(text, encryptedSettingPrefix) != decrypt {
			continue
		}
		converted, err := transform(text)
		if err != nil {
			return err
		}
		header["value"] = converted
	}
	return nil
}
