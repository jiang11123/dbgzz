package app

import (
	"context"
	"errors"
	"net"
	"net/http"
	"strings"
	"time"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/modelcatalog"
)

type ChannelModelsRequest struct {
	BaseURL       string           `json:"baseUrl"`
	APIKey        string           `json:"apiKey"`
	APIFormat     string           `json:"apiFormat"`
	Headers       []OutboundHeader `json:"headers"`
	ChannelID     string           `json:"channelId"`
	CredentialRef string           `json:"credentialRef"`
}

func (s *Service) FetchChannelModels(ctx context.Context, actor *model.User, input ChannelModelsRequest) ([]string, error) {
	items, err := s.FetchChannelModelCatalog(ctx, actor, input)
	if err != nil {
		return nil, err
	}
	return modelcatalog.CatalogModelIDs(items), nil
}

func (s *Service) FetchChannelModelCatalog(ctx context.Context, actor *model.User, input ChannelModelsRequest) ([]ChannelModelCatalogItem, error) {
	if actor == nil || strings.TrimSpace(actor.ID) == "" {
		return nil, Unauthorized("请先登录")
	}
	if err := s.resolveChannelModelsRequest(&input); err != nil {
		return nil, err
	}
	headers, err := NormalizeOutboundHeaders(input.Headers)
	if err != nil {
		return nil, err
	}
	catalog, err := modelcatalog.LoadChannelModelCatalog(ctx, s.fetchChannelModelCatalogBytes, input.BaseURL, input.APIFormat, input.APIKey, headers, s.catalogExtraSource())
	if err != nil {
		return nil, mapChannelModelCatalogError(err)
	}
	return catalog, nil
}

func (s *Service) fetchChannelModelCatalogBytes(ctx context.Context, baseURL, apiFormat, apiKey string, headers []modelcatalog.ChannelHeader) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	target := apiURL(baseURL, "/models")
	if apiFormat == "gemini" {
		if !strings.HasSuffix(strings.ToLower(baseURL), "/v1beta") {
			baseURL += "/v1beta"
		}
		target = baseURL + "/models"
	}
	if _, err := ValidateOutboundURL(target); err != nil {
		return nil, catalogError(http.StatusBadRequest, "catalog_address_invalid", err.Error(), err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, BadAuthRequest("模型服务地址无效")
	}
	if apiFormat == "gemini" {
		request.Header.Set("x-goog-api-key", apiKey)
	} else {
		request.Header.Set("Authorization", "Bearer "+apiKey)
	}
	ApplyOutboundHeaders(request, headers)
	data, _, err := doBinary(request)
	if err != nil {
		var httpErr providerHTTPError
		if errors.As(err, &httpErr) {
			return nil, modelcatalog.CatalogFetchError{StatusCode: httpErr.StatusCode, Cause: err}
		}
		return nil, modelcatalog.CatalogFetchError{Cause: err}
	}
	return data, nil
}

func (s *Service) catalogExtraSource() modelcatalog.CatalogExtraSource {
	if s == nil || !s.isPluginEnabled() {
		return nil
	}
	return extraChannelModelCatalogItems
}

func mapChannelModelCatalogError(err error) error {
	if err == nil {
		return nil
	}
	var fetchErr modelcatalog.CatalogFetchError
	if errors.As(err, &fetchErr) {
		return channelModelsUpstreamError(fetchErr.Cause)
	}
	var jsonErr modelcatalog.CatalogJSONError
	if errors.As(err, &jsonErr) {
		return catalogError(http.StatusBadGateway, "catalog_response_invalid", "模型目录响应格式不兼容，需要 OpenAI data 数组或 Gemini models 数组", jsonErr.Cause)
	}
	var rejected modelcatalog.CatalogUpstreamRejectedError
	if errors.As(err, &rejected) {
		return catalogError(http.StatusBadGateway, "catalog_upstream_rejected", rejected.Error(), err)
	}
	return err
}

func channelModelsUpstreamError(err error) error {
	var network net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &network) && network.Timeout()) {
		return catalogError(http.StatusGatewayTimeout, "catalog_timeout", "读取模型目录超时，请检查渠道地址和网络后重试", err)
	}
	var authErr *AuthError
	if errors.As(err, &authErr) {
		return authErr
	}
	var httpErr providerHTTPError
	if !errors.As(err, &httpErr) {
		return catalogError(http.StatusBadGateway, "catalog_network_failed", "连接模型服务失败，请检查渠道地址和网络", err)
	}
	switch httpErr.StatusCode {
	case http.StatusUnauthorized, http.StatusForbidden:
		return catalogError(http.StatusBadGateway, "catalog_auth_failed", "模型服务鉴权失败，请检查 API Key 或服务商访问权限", err)
	case http.StatusNotFound:
		return catalogError(http.StatusBadGateway, "catalog_unsupported", "模型服务未提供此模型目录接口，请核对地址或手动添加模型", err)
	case http.StatusMethodNotAllowed, http.StatusNotImplemented:
		return catalogError(http.StatusBadGateway, "catalog_unsupported", "模型服务不支持读取模型目录，请手动添加模型", err)
	case http.StatusTooManyRequests:
		return catalogError(http.StatusBadGateway, "catalog_rate_limited", "模型服务请求过于频繁或额度不足", err)
	default:
		return catalogError(http.StatusBadGateway, "catalog_upstream_failed", httpErr.Error(), err)
	}
}

func catalogError(status int, reason kernel.ErrorReason, message string, cause error) *AppError {
	err := WrapAppError(status, message, cause)
	err.Reason = reason
	return err
}
