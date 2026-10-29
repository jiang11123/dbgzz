package assistantruntime

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
)

// HostHealth is the public probe result. It never includes the instance nonce.
type HostHealth struct {
	OK       bool
	Busy     bool
	Model    string
	Reason   string
	Instance string
}

func probeOwned(ctx context.Context, baseURL, nonce, token string) HostHealth {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" || strings.TrimSpace(nonce) == "" {
		return HostHealth{}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/health", nil)
	if err != nil {
		return HostHealth{}
	}
	applyInstanceHeaders(req, token, nonce)
	client := &http.Client{
		Timeout: 3 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	resp, err := client.Do(req)
	if err != nil {
		return HostHealth{}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 16<<10))
	var payload map[string]any
	_ = json.Unmarshal(body, &payload)
	health := HostHealth{}
	if payload != nil {
		health.Busy, _ = payload["busy"].(bool)
		health.Model, _ = payload["model"].(string)
		health.Reason, _ = payload["reason"].(string)
		health.Instance, _ = payload["instance"].(string)
	}
	if resp.StatusCode != http.StatusOK {
		return health
	}
	if health.Instance != InstanceProof(nonce) {
		return HostHealth{}
	}
	health.OK = true
	if ready, found := payload["ok"].(bool); found && !ready {
		health.OK = false
	}
	return health
}

func (h *Host) Probe(ctx context.Context) HostHealth {
	if h == nil {
		return HostHealth{}
	}
	if ctx == nil {
		ctx = context.Background()
	}
	base, nonce := h.proc.identity()
	if base == "" || nonce == "" {
		return HostHealth{}
	}
	return probeOwned(ctx, base, nonce, h.hostToken())
}

func (h *Host) NewChildRequest(ctx context.Context, method, path string, body io.Reader) (*http.Request, error) {
	if h == nil {
		return nil, invalidArg("host_unreachable", "内置创作助手宿主未运行")
	}
	base, nonce := h.proc.identity()
	if strings.TrimSpace(base) == "" || nonce == "" {
		return nil, invalidArg("host_unreachable", "内置创作助手宿主未运行")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	req, err := http.NewRequestWithContext(ctx, method, base+path, body)
	if err != nil {
		return nil, err
	}
	applyInstanceHeaders(req, h.hostToken(), nonce)
	return req, nil
}
