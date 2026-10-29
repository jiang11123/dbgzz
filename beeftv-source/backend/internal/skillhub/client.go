// Package skillhub is the desktop transport for the separately hosted Skill market.
package skillhub

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const DefaultURL = "https://beeftv.app/api/beeftv/skillhub/v1"
const MaxArchiveBytes = 10 << 20

type File struct {
	Path     string `json:"path"`
	SHA256   string `json:"sha256"`
	Size     int64  `json:"size"`
	MimeType string `json:"mimeType"`
}
type Showcase struct {
	URL     string `json:"url"`
	Type    string `json:"type"`
	Caption string `json:"caption"`
}
type Metadata struct {
	SkillID          string     `json:"skillId,omitempty"`
	Name             string     `json:"name"`
	Description      string     `json:"description"`
	License          string     `json:"license"`
	SourceURL        string     `json:"sourceUrl"`
	VersionLabel     string     `json:"versionLabel"`
	Requirements     []string   `json:"requirements"`
	RequirementNotes string     `json:"requirementNotes,omitempty"`
	Showcase         []Showcase `json:"showcase"`
	MinClientVersion string     `json:"minClientVersion,omitempty"`
	Tags             []string   `json:"tags,omitempty"`
	Aliases          []string   `json:"aliases,omitempty"`
}
type Release struct {
	Metadata
	Review        *ReviewSummary `json:"review,omitempty"`
	ReleaseID     string         `json:"releaseId"`
	Author        string         `json:"author"`
	ContentHash   string         `json:"contentHash"`
	ArchiveSHA256 string         `json:"archiveSha256"`
	ArchiveBytes  int64          `json:"archiveBytes"`
	Files         []File         `json:"files"`
	DownloadURL   string         `json:"downloadUrl"`
	PublishedAt   string         `json:"publishedAt"`
	Signature     string         `json:"signature,omitempty"`
	Attestation   *Attestation   `json:"attestation,omitempty"`
}
type ReviewSummary struct {
	ReviewedAt    string        `json:"reviewedAt"`
	Revision      int64         `json:"revision"`
	ContentHash   string        `json:"contentHash"`
	ArchiveSHA256 string        `json:"archiveSha256"`
	PreviewDigest string        `json:"previewDigest"`
	Trials        []ReviewTrial `json:"trials"`
}
type ReviewTrial struct {
	Scenario       string `json:"scenario"`
	Target         string `json:"target"`
	RuntimeVersion string `json:"runtimeVersion"`
	Model          string `json:"model"`
	Conclusion     string `json:"conclusion"`
	TestedAt       string `json:"testedAt"`
}
type Attestation struct {
	Algorithm string `json:"algorithm"`
	KeyID     string `json:"keyId"`
	Payload   string `json:"payload"`
	Signature string `json:"signature"`
}
type Catalog struct {
	Items    []Release `json:"items"`
	Total    int64     `json:"total"`
	Page     int       `json:"page"`
	PageSize int       `json:"pageSize"`
}
type Draft struct {
	ReviewReason  string   `json:"reviewReason,omitempty"`
	ContentHash   string   `json:"contentHash"`
	ArchiveSHA256 string   `json:"archiveSha256"`
	ArchiveBytes  int64    `json:"archiveBytes"`
	SubmissionID  string   `json:"submissionId"`
	Revision      int64    `json:"revision"`
	Status        string   `json:"status"`
	Metadata      Metadata `json:"metadata"`
	Files         []File   `json:"files"`
	PreviewDigest string   `json:"previewDigest"`
	Warnings      []string `json:"warnings"`
}
type Authorization struct {
	DeviceCode      string `json:"deviceCode"`
	UserCode        string `json:"userCode"`
	VerificationURL string `json:"verificationUrl"`
	ExpiresIn       int64  `json:"expiresIn"`
	Interval        int    `json:"interval"`
}
type Token struct {
	AccessToken string `json:"accessToken"`
	ExpiresIn   int64  `json:"expiresIn"`
}
type PublishingAccount struct {
	UserID      int    `json:"userId"`
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
}
type Preview struct {
	Author        string   `json:"author"`
	SubmissionID  string   `json:"submissionId"`
	Revision      int64    `json:"revision"`
	PreviewDigest string   `json:"previewDigest"`
	Files         []File   `json:"files"`
	Metadata      Metadata `json:"metadata"`
	Warnings      []string `json:"warnings"`
}

type Error struct {
	Status     int
	Reason     string
	Message    string
	RetryAfter string
}

func (e *Error) Error() string {
	if e.Message != "" {
		return e.Message
	}
	return e.Reason
}

type Client struct {
	base *url.URL
	HTTP *http.Client
}

func (c *Client) BaseURL() string { return c.base.String() }

func New(base string) (*Client, error) {
	u, err := url.Parse(strings.TrimRight(base, "/"))
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost" || u.Hostname() == "::1"))) {
		return nil, fmt.Errorf("技能市场地址必须是可信 HTTPS 服务")
	}
	c := &Client{base: u}
	c.HTTP = &http.Client{Timeout: 45 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if req.URL.Scheme != u.Scheme || req.URL.Host != u.Host || !strings.HasPrefix(req.URL.Path, u.Path+"/") {
			return fmt.Errorf("技能市场下载跳转到未信任地址")
		}
		if len(via) > 3 {
			return fmt.Errorf("技能市场跳转过多")
		}
		return nil
	}}
	return c, nil
}

func (c *Client) URL(route string) (string, error) {
	u, err := url.Parse(route)
	if err != nil {
		return "", err
	}
	if strings.Contains(u.Path, "..") || strings.Contains(u.Path, "\\") {
		return "", fmt.Errorf("技能市场路径无效")
	}
	if u.IsAbs() || u.Host != "" {
		if u.Scheme != c.base.Scheme || u.Host != c.base.Host {
			return "", fmt.Errorf("技能市场地址不受信任")
		}
		if !strings.HasPrefix(u.Path, c.base.Path+"/") {
			return "", fmt.Errorf("技能市场路径不受信任")
		}
		return u.String(), nil
	}
	copy := *c.base
	if strings.HasPrefix(u.Path, c.base.Path+"/") {
		copy.Path = u.Path
	} else {
		copy.Path += "/" + strings.TrimLeft(u.Path, "/")
	}
	copy.RawQuery = u.RawQuery
	return copy.String(), nil
}

func (c *Client) Request(ctx context.Context, method, route, token, contentType, key string, body io.Reader) (*http.Response, error) {
	target, err := c.URL(route)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, method, target, body)
	if err != nil {
		return nil, err
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if key != "" {
		req.Header.Set("Idempotency-Key", key)
	}
	return c.HTTP.Do(req)
}
func Decode(res *http.Response, out any) error {
	defer res.Body.Close()
	var e struct {
		Success bool            `json:"success"`
		Data    json.RawMessage `json:"data"`
		Message string          `json:"message"`
		Reason  string          `json:"reason"`
		Error   struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 2<<20)).Decode(&e); err != nil {
		return &Error{Status: 502, Reason: "market_unreadable", Message: "技能市场返回内容无法读取"}
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 || !e.Success {
		if e.Reason == "" {
			e.Reason = e.Error.Code
		}
		if e.Message == "" {
			e.Message = e.Error.Message
		}
		if e.Reason == "" {
			e.Reason = "market_request_failed"
		}
		return &Error{Status: res.StatusCode, Reason: e.Reason, Message: e.Message, RetryAfter: res.Header.Get("Retry-After")}
	}
	if out != nil {
		return json.Unmarshal(e.Data, out)
	}
	return nil
}
func (c *Client) JSON(ctx context.Context, method, route, token, key string, input, out any) error {
	var body io.Reader
	if input != nil {
		data, err := json.Marshal(input)
		if err != nil {
			return err
		}
		body = bytes.NewReader(data)
	}
	res, err := c.Request(ctx, method, route, token, "application/json", key, body)
	if err != nil {
		return &Error{Status: 503, Reason: "market_unavailable", Message: "技能市场暂时无法连接，请稍后重试"}
	}
	return Decode(res, out)
}

func (c *Client) Archive(ctx context.Context, route string) ([]byte, error) {
	return c.ArchiveWithToken(ctx, route, "")
}
func (c *Client) ArchiveWithToken(ctx context.Context, route, token string) ([]byte, error) {
	res, err := c.Request(ctx, "GET", route, token, "", "", nil)
	if err != nil {
		return nil, &Error{Status: 503, Reason: "market_unavailable", Message: "技能市场暂时无法连接，请稍后重试"}
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, Decode(res, nil)
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, MaxArchiveBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > MaxArchiveBytes {
		return nil, fmt.Errorf("技能下载包超过10MiB")
	}
	return data, nil
}
