package beefapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
)

type deviceCodeRequest struct {
	ClientID      string `json:"client_id"`
	Scope         string `json:"scope"`
	ClientVersion string `json:"client_version"`
	Hostname      string `json:"hostname"`
}

type deviceCodeResponse struct {
	DeviceCode              string `json:"device_code"`
	UserCode                string `json:"user_code"`
	VerificationURI         string `json:"verification_uri"`
	VerificationURIComplete string `json:"verification_uri_complete"`
	ExpiresIn               int    `json:"expires_in"`
	Interval                int    `json:"interval"`
}

type tokenRequest struct {
	ClientID   string `json:"client_id"`
	DeviceCode string `json:"device_code"`
}

type tokenSuccess struct {
	APIKey  string  `json:"api_key"`
	BaseURL string  `json:"base_url"`
	Market  string  `json:"market"`
	Group   string  `json:"group"`
	KeyName string  `json:"key_name"`
	TokenID wireID  `json:"token_id"`
	Account Account `json:"account"`
}

type completeRequest struct {
	ClientID   string `json:"client_id"`
	DeviceCode string `json:"device_code"`
}

type oauthError struct {
	Error            string `json:"error"`
	ErrorDescription string `json:"error_description"`
	ErrorCode        string `json:"error_code"`
}

type connectionView struct {
	Market  string  `json:"market"`
	Account Account `json:"account"`
	TokenID wireID  `json:"token_id"`
	KeyName string  `json:"key_name"`
}

type modelsPayload struct {
	Data []struct {
		ID                       string          `json:"id"`
		Name                     string          `json:"name"`
		DisplayName              string          `json:"display_name"`
		ModelType                string          `json:"model_type"`
		SupportedEndpointTypes   []string        `json:"supported_endpoint_types"`
		VideoCapabilities        json.RawMessage `json:"video_capabilities"`
		VideoCapabilitiesVersion string          `json:"video_capabilities_version"`
		VideoPricing             json.RawMessage `json:"video_pricing"`
	} `json:"data"`
}

func (s *Service) postJSON(path string, payload any, header http.Header) (*http.Response, []byte, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, nil, err
	}
	request, err := http.NewRequestWithContext(s.lifecycle, http.MethodPost, s.Origin()+path, bytes.NewReader(body))
	if err != nil {
		return nil, nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	for key, values := range header {
		for _, value := range values {
			request.Header.Add(key, value)
		}
	}
	response, err := s.httpClient.Do(request)
	if err != nil {
		return nil, nil, err
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return response, nil, err
	}
	return response, raw, nil
}

func (s *Service) requestDeviceCode() (deviceCodeResponse, error) {
	response, raw, err := s.postJSON("/api/oauth/device/code", deviceCodeRequest{
		ClientID:      ClientID,
		Scope:         ClientScope,
		ClientVersion: s.clientVersion,
		Hostname:      s.hostname,
	}, nil)
	if err != nil {
		return deviceCodeResponse{}, fmt.Errorf("无法连接 BeefTV 服务，请检查网络后重试")
	}
	if response.StatusCode >= 300 {
		if response.StatusCode == http.StatusTooManyRequests {
			return deviceCodeResponse{}, fmt.Errorf("连接尝试过于频繁，请稍后重试")
		}
		if response.StatusCode >= 500 {
			return deviceCodeResponse{}, fmt.Errorf("BeefTV 连接服务暂时不可用，请稍后重试")
		}
		return deviceCodeResponse{}, fmt.Errorf("BeefTV 服务未接受连接，请更新应用后重试")
	}
	var result deviceCodeResponse
	if err := json.Unmarshal(raw, &result); err != nil || strings.TrimSpace(result.DeviceCode) == "" || strings.TrimSpace(result.UserCode) == "" {
		return deviceCodeResponse{}, fmt.Errorf("企业授权响应无效")
	}
	if result.ExpiresIn <= 0 {
		result.ExpiresIn = 900
	}
	if result.Interval <= 0 {
		result.Interval = 5
	}
	if result.VerificationURI == "" {
		result.VerificationURI = s.Origin() + "/desktop-auth"
	}
	if _, err := ValidateVerificationURL(s.Origin(), result.VerificationURI); err != nil {
		return deviceCodeResponse{}, err
	}
	if result.VerificationURIComplete != "" {
		if _, err := ValidateVerificationURL(s.Origin(), result.VerificationURIComplete); err != nil {
			return deviceCodeResponse{}, err
		}
	}
	return result, nil
}

func (s *Service) pollToken(deviceCode string) (tokenSuccess, string, error) {
	response, raw, err := s.postJSON("/api/oauth/device/token", tokenRequest{ClientID: ClientID, DeviceCode: deviceCode}, nil)
	if err != nil {
		return tokenSuccess{}, "", fmt.Errorf("查询授权状态失败")
	}
	if response.StatusCode == http.StatusOK {
		var result tokenSuccess
		if err := json.Unmarshal(raw, &result); err != nil {
			return tokenSuccess{}, "", fmt.Errorf("企业授权响应无效")
		}
		return result, "", nil
	}
	code := parseOAuthError(raw)
	if code == "" {
		code = "invalid_request"
	}
	return tokenSuccess{}, code, nil
}

var (
	errAckTransient = fmt.Errorf("确认企业授权失败")
	errAckExpired   = fmt.Errorf("授权已过期，请重新连接")
	errAckRejected  = fmt.Errorf("授权被拒绝")
)

func (s *Service) acknowledge(deviceCode string) error {
	response, raw, err := s.postJSON("/api/oauth/device/complete", completeRequest{ClientID: ClientID, DeviceCode: deviceCode}, nil)
	if err != nil {
		return errAckTransient
	}
	if response.StatusCode == http.StatusOK {
		var result struct {
			Success bool `json:"success"`
		}
		if err := json.Unmarshal(raw, &result); err == nil && result.Success {
			return nil
		}
		if err := permanentAckError(parseOAuthError(raw)); err != nil {
			return err
		}
		return errAckTransient
	}
	if response.StatusCode >= 500 || response.StatusCode == http.StatusTooManyRequests {
		return errAckTransient
	}
	if err := permanentAckError(parseOAuthError(raw)); err != nil {
		return err
	}
	if response.StatusCode >= 400 {
		return permanentAckError("invalid_request")
	}
	return errAckTransient
}

func permanentAckError(code string) error {
	switch code {
	case "expired_token", "expired", "invalid_request":
		return errAckExpired
	case "access_denied", "denied", "rejected":
		return errAckRejected
	default:
		return nil
	}
}

func isPermanentAck(err error) bool {
	return errors.Is(err, errAckExpired) || errors.Is(err, errAckRejected)
}

func (s *Service) cancelRemote(deviceCode string) error {
	if strings.TrimSpace(deviceCode) == "" {
		return nil
	}
	_, _, err := s.postJSON("/api/oauth/device/cancel", completeRequest{ClientID: ClientID, DeviceCode: deviceCode}, nil)
	return err
}

func (s *Service) remoteConnection(apiKey string) (connectionView, int, error) {
	request, err := http.NewRequestWithContext(s.lifecycle, http.MethodGet, TokenBaseURL(s.Origin())+"/beeftv/connection", nil)
	if err != nil {
		return connectionView{}, 0, err
	}
	request.Header.Set("Authorization", "Bearer "+apiKey)
	request.Header.Set("Accept", "application/json")
	response, err := s.httpClient.Do(request)
	if err != nil {
		return connectionView{}, 0, err
	}
	defer response.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if response.StatusCode >= 300 {
		return connectionView{}, response.StatusCode, nil
	}
	var view connectionView
	if err := json.Unmarshal(raw, &view); err != nil {
		return connectionView{}, response.StatusCode, fmt.Errorf("企业连接信息无效")
	}
	return view, response.StatusCode, nil
}

func (s *Service) revokeRemote(apiKey string) error {
	request, err := http.NewRequestWithContext(s.lifecycle, http.MethodDelete, TokenBaseURL(s.Origin())+"/beeftv/connection", nil)
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+apiKey)
	response, err := s.httpClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 1<<16))
	if response.StatusCode != http.StatusNoContent && response.StatusCode != http.StatusOK && response.StatusCode != http.StatusUnauthorized {
		return fmt.Errorf("断开企业连接失败")
	}
	return nil
}

func (s *Service) fetchModels(apiKey string) ([]CatalogModel, error) {
	if s.fetchCatalog != nil {
		return s.fetchCatalog(apiKey, ProviderBaseURL(s.Origin()))
	}
	request, err := http.NewRequestWithContext(s.lifecycle, http.MethodGet, TokenBaseURL(s.Origin())+"/models", nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+apiKey)
	request.Header.Set("Accept", "application/json")
	response, err := s.httpClient.Do(request)
	if err != nil {
		return nil, fmt.Errorf("读取模型列表失败")
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 4<<20))
	if err != nil {
		return nil, fmt.Errorf("读取模型列表失败")
	}
	if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
		return nil, errRevoked
	}
	if response.StatusCode >= 300 {
		return nil, fmt.Errorf("读取模型列表失败")
	}
	var payload modelsPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, fmt.Errorf("模型列表无效")
	}
	models := make([]CatalogModel, 0, len(payload.Data))
	seen := map[string]bool{}
	for _, item := range payload.Data {
		id := strings.TrimSpace(item.ID)
		if id == "" {
			id = strings.TrimSpace(item.Name)
		}
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		models = append(models, CatalogModel{
			ID:                       id,
			DisplayName:              strings.TrimSpace(item.DisplayName),
			ModelType:                strings.ToLower(strings.TrimSpace(item.ModelType)),
			SupportedEndpointTypes:   item.SupportedEndpointTypes,
			VideoCapabilities:        append(json.RawMessage(nil), item.VideoCapabilities...),
			VideoCapabilitiesVersion: strings.TrimSpace(item.VideoCapabilitiesVersion),
			VideoPricing:             append(json.RawMessage(nil), item.VideoPricing...),
		})
	}
	return models, nil
}

func parseOAuthError(raw []byte) string {
	var payload map[string]any
	if json.Unmarshal(raw, &payload) != nil {
		var legacy oauthError
		if json.Unmarshal(raw, &legacy) == nil {
			return firstNonEmpty(legacy.Error, legacy.ErrorCode)
		}
		return ""
	}
	switch typed := payload["error"].(type) {
	case string:
		if typed != "" {
			return typed
		}
	case map[string]any:
		if code, _ := typed["code"].(string); code != "" {
			return code
		}
		if code, _ := typed["error"].(string); code != "" {
			return code
		}
	}
	if code, _ := payload["error_code"].(string); code != "" {
		return code
	}
	return ""
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func validateTokenSuccess(origin string, token tokenSuccess) (accountID, tokenID string, err error) {
	if err := ValidateReturnedBaseURL(origin, token.BaseURL); err != nil {
		return "", "", err
	}
	if token.Market != "enterprise" {
		return "", "", errors.New("企业授权市场无效")
	}
	if token.Group != "enterprise" {
		return "", "", errors.New("企业授权分组无效")
	}
	if strings.TrimSpace(token.APIKey) == "" {
		return "", "", errors.New("企业授权密钥无效")
	}
	accountID, err = positiveIdentity(token.Account.ID, "企业账号无效")
	if err != nil {
		return "", "", err
	}
	tokenID, err = positiveIdentity(token.TokenID, "企业授权凭证无效")
	if err != nil {
		return "", "", err
	}
	return accountID, tokenID, nil
}
