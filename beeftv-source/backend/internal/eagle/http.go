package eagle

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

func (c *Client) jsonRequest(method string, baseURL *url.URL, endpoint string, payload any, target any) error {
	requestURL := *baseURL
	endpointURL, err := url.Parse(endpoint)
	if err != nil || endpointURL.IsAbs() || endpointURL.Host != "" || endpointURL.Path == "" {
		return errors.New("Eagle API 路径无效")
	}
	requestURL.Path = strings.TrimRight(requestURL.Path, "/") + endpointURL.Path
	requestURL.RawQuery = endpointURL.RawQuery
	var body io.Reader
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		body = strings.NewReader(string(encoded))
	}
	request, err := http.NewRequestWithContext(context.Background(), method, requestURL.String(), body)
	if err != nil {
		return err
	}
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	trusted := *request.URL
	trusted.User = nil
	client := &http.Client{
		Timeout:       2 * time.Minute,
		Transport:     pinnedRoundTripper{base: c.roundTripper(), trusted: &trusted},
		CheckRedirect: denyRedirects,
	}
	response, err := client.Do(request)
	if err != nil {
		return errors.New("无法连接 Eagle，请确认 Eagle 已启动并打开素材库")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		if response.StatusCode == http.StatusNotFound {
			return errors.New("Eagle 未找到当前接口或素材，请确认 Eagle 已打开素材库并使用默认 API 地址")
		}
		return fmt.Errorf("Eagle API 返回 HTTP %d", response.StatusCode)
	}
	if err := json.NewDecoder(response.Body).Decode(target); err != nil {
		return errors.New("Eagle API 返回了无法解析的数据")
	}
	return nil
}

func (c *Client) roundTripper() http.RoundTripper {
	if c != nil && c.transport != nil {
		return c.transport
	}
	return loopbackTransport()
}

func loopbackTransport() http.RoundTripper {
	if base, ok := http.DefaultTransport.(*http.Transport); ok {
		transport := base.Clone()
		transport.Proxy = nil
		return transport
	}
	return &http.Transport{Proxy: nil}
}

func denyRedirects(*http.Request, []*http.Request) error {
	return http.ErrUseLastResponse
}

type pinnedRoundTripper struct {
	base    http.RoundTripper
	trusted *url.URL
}

func (p pinnedRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	if p.trusted == nil || req == nil || req.URL == nil || req.URL.User != nil || !sameTrustedDestination(p.trusted, req.URL) {
		return nil, errors.New("Eagle 只允许连接已校验的本机地址")
	}
	base := p.base
	if base == nil {
		base = loopbackTransport()
	}
	return base.RoundTrip(req)
}

func sameTrustedDestination(trusted, got *url.URL) bool {
	if trusted == nil || got == nil {
		return false
	}
	if !strings.EqualFold(strings.TrimSpace(trusted.Scheme), strings.TrimSpace(got.Scheme)) {
		return false
	}
	if strings.ToLower(trusted.Hostname()) != strings.ToLower(got.Hostname()) {
		return false
	}
	return effectivePort(trusted) == effectivePort(got)
}

func effectivePort(value *url.URL) string {
	if value == nil {
		return ""
	}
	if port := value.Port(); port != "" {
		return port
	}
	switch strings.ToLower(value.Scheme) {
	case "http":
		return "80"
	case "https":
		return "443"
	default:
		return ""
	}
}
