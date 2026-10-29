package app

import (
	"encoding/json"
	"errors"
	"net/url"
	"strings"

	"infinite-canvas/backend/internal/beefapi"
)

const managedBeefAPIRef = beefapi.CredentialRef

func (s *Service) SetBeefAPI(connection *beefapi.Service) {
	if s == nil {
		return
	}
	s.beefAPI = connection
}

func (s *Service) BeefAPI() *beefapi.Service {
	if s == nil {
		return nil
	}
	return s.beefAPI
}

func (s *Service) resolveManagedBeefAPISecrets(input map[string]any) (map[string]any, error) {
	if input == nil {
		return input, nil
	}
	config, ok := input["config"].(map[string]any)
	if !ok {
		return input, nil
	}
	channelID := strings.TrimSpace(stringValue(config["channelId"]))
	credentialRef := strings.TrimSpace(stringValue(config["credentialRef"]))
	baseURL := strings.TrimSpace(stringValue(config["baseUrl"]))
	if !beefapi.IsManagedChannel(channelID, credentialRef, baseURL) && !s.hasLegacyBeefAPIKey(channelID, baseURL) {
		return input, nil
	}
	apiKey, resolvedBase, accountID, tokenID, err := s.lookupBeefAPICredential()
	if err != nil {
		var structured *AppError
		if errors.As(err, &structured) && structured.Reason == "local_credential_failed" {
			copy := *structured
			copy.Message = "尚未提交生成。" + structured.Message
			return nil, &copy
		}
		return nil, err
	}
	if apiKey == "" {
		return input, nil
	}
	next := make(map[string]any, len(config)+4)
	for key, value := range config {
		switch key {
		case "apiKey", "credentialRef":
			continue
		default:
			next[key] = value
		}
	}
	if channelID == beefapi.ChannelID {
		delete(next, "channelId")
	}
	next["apiKey"] = apiKey
	if strings.TrimSpace(stringValue(next["baseUrl"])) == "" || beefapi.IsEnterpriseBaseURL(baseURL) || channelID == beefapi.ChannelID || credentialRef == managedBeefAPIRef {
		next["baseUrl"] = resolvedBase
	}
	next["credentialRef"] = managedBeefAPIRef
	if accountID != "" {
		next["managedAccountId"] = accountID
	}
	if tokenID != "" {
		next["managedTokenId"] = tokenID
	}
	input["config"] = next
	return input, nil
}

func (s *Service) lookupBeefAPICredential() (apiKey, baseURL, accountID, tokenID string, err error) {
	if s.beefAPI != nil {
		if s.beefAPI.HasManagedCredential() {
			cred, resolveErr := s.beefAPI.Resolve()
			if resolveErr != nil {
				var structured *AppError
				if errors.As(resolveErr, &structured) {
					return "", "", "", "", structured
				}
				return "", "", "", "", BadAuthRequest(resolveErr.Error())
			}
			return cred.APIKey, cred.BaseURL, cred.AccountID, cred.TokenID, nil
		}
	}
	body, readErr := s.ReadLocalModelConfig()
	if readErr != nil || len(body) == 0 {
		return "", "", "", "", nil
	}
	var config struct {
		Channels []struct {
			ID      string `json:"id"`
			APIKey  string `json:"apiKey"`
			BaseURL string `json:"baseUrl"`
		} `json:"channels"`
	}
	if json.Unmarshal(body, &config) != nil {
		return "", "", "", "", nil
	}
	for _, channel := range config.Channels {
		if channel.ID == beefapi.ChannelID && strings.TrimSpace(channel.APIKey) != "" {
			base := strings.TrimSpace(channel.BaseURL)
			if base == "" {
				base = beefapi.LegacyOrigin
			}
			return channel.APIKey, base, "", "", nil
		}
	}
	return "", "", "", "", nil
}

func (s *Service) hasLegacyBeefAPIKey(channelID, baseURL string) bool {
	if channelID != beefapi.ChannelID && !beefapi.IsEnterpriseBaseURL(baseURL) {
		return false
	}
	apiKey, _, _, _, err := s.lookupBeefAPICredential()
	return err == nil && apiKey != ""
}

func (s *Service) resolveChannelModelsRequest(input *ChannelModelsRequest) error {
	if input == nil {
		return nil
	}
	if !beefapi.IsManagedChannel(input.ChannelID, input.CredentialRef, input.BaseURL) && input.ChannelID != beefapi.ChannelID {
		return nil
	}
	apiKey, baseURL, _, _, err := s.lookupBeefAPICredential()
	if err != nil {
		return err
	}
	if apiKey == "" {
		return nil
	}
	input.APIKey = apiKey
	// Stored credentials must only be sent to their configured origin.
	input.BaseURL = baseURL
	input.CredentialRef = managedBeefAPIRef
	return nil
}

func (s *Service) ResolveCustomRelayAPIKey(targetURL, incoming string) (string, error) {
	return s.resolveCustomRelayKey(targetURL, incoming)
}

func (s *Service) resolveCustomRelayKey(targetURL, incoming string) (string, error) {
	// An unrelated custom channel must remain usable even if the managed
	// connection is revoked. Resolve its secret only for the bound origin.
	if s.beefAPI != nil && s.beefAPI.HasManagedCredential() && !sameCredentialOrigin(targetURL, s.beefAPI.Origin()) {
		return incoming, nil
	}
	apiKey, baseURL, _, _, err := s.lookupBeefAPICredential()
	if err != nil {
		return "", err
	}
	if apiKey == "" || !sameCredentialOrigin(targetURL, baseURL) {
		return incoming, nil
	}
	return apiKey, nil
}

func sameCredentialOrigin(targetURL, baseURL string) bool {
	target, targetErr := url.Parse(strings.TrimSpace(targetURL))
	base, baseErr := url.Parse(strings.TrimSpace(baseURL))
	if targetErr != nil || baseErr != nil || target.User != nil || base.User != nil || target.Host == "" || base.Host == "" {
		return false
	}
	if target.Scheme != "https" && target.Scheme != "http" {
		return false
	}
	return strings.EqualFold(target.Scheme, base.Scheme) && strings.EqualFold(target.Host, base.Host)
}

func (s *Service) noteBeefAPIProviderError(message string) {
	if s == nil || s.beefAPI == nil {
		return
	}
	normalized := strings.ToLower(message)
	if strings.Contains(normalized, "unauthorized") || strings.Contains(message, "连接已失效") {
		s.beefAPI.MarkRevoked()
	}
	if strings.Contains(message, "额度不足") || strings.Contains(normalized, "insufficient") || strings.Contains(message, "余额不足") {
		s.beefAPI.MarkZeroBalance()
	}
}
