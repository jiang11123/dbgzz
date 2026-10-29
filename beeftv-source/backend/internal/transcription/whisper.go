package transcription

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type whisperSegment struct {
	Start float64 `json:"start"`
	End   float64 `json:"end"`
	Text  string  `json:"text"`
}

type whisperVerboseJSON struct {
	Segments []whisperSegment `json:"segments"`
	Language string           `json:"language"`
}

type Client struct {
	BaseURL string
	HTTP    *http.Client
	Model   string
	APIKey  string
}

func NewClient(baseURL string) *Client {
	return &Client{
		BaseURL: strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		HTTP:    &http.Client{Timeout: 20 * time.Minute},
	}
}

func (c *Client) Transcribe(ctx context.Context, wavPath string, language string) ([]Segment, string, error) {
	if c == nil || c.BaseURL == "" {
		return nil, "", fmt.Errorf("本地转写服务未配置：请设置 %s", BaseURLEnv)
	}
	httpClient := c.HTTP
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 20 * time.Minute}
	}
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	audio, err := os.Open(wavPath)
	if err != nil {
		return nil, "", fmt.Errorf("读取待转写音频失败: %w", err)
	}
	defer audio.Close()
	if c.Model != "" {
		info, err := audio.Stat()
		if err != nil {
			return nil, "", fmt.Errorf("读取音频大小失败")
		}
		if info.Size() > 25<<20 {
			return nil, "", fmt.Errorf("云端转写音频超过 25 MB，请缩短素材后重试")
		}
		if err := writer.WriteField("model", c.Model); err != nil {
			return nil, "", err
		}
	}
	part, err := writer.CreateFormFile("file", filepath.Base(wavPath))
	if err != nil {
		return nil, "", err
	}
	if _, err := io.Copy(part, audio); err != nil {
		return nil, "", fmt.Errorf("上传音频失败: %w", err)
	}
	if err := writer.WriteField("response_format", "verbose_json"); err != nil {
		return nil, "", err
	}
	if strings.TrimSpace(language) != "" {
		if err := writer.WriteField("language", strings.TrimSpace(language)); err != nil {
			return nil, "", err
		}
	}
	if err := writer.Close(); err != nil {
		return nil, "", err
	}

	endpoint := c.BaseURL + "/inference"
	if c.Model != "" {
		endpoint = strings.TrimSuffix(c.BaseURL, "/v1") + "/v1/audio/transcriptions"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, &body)
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())
	if c.Model != "" {
		req.Header.Set("Authorization", "Bearer "+c.APIKey)
	}
	// Never forward credentials or replay a paid upload across redirects.
	client := *httpClient
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, "", ctx.Err()
		}
		return nil, "", fmt.Errorf("无法连接转写服务，请检查连接后重试")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		if c.Model != "" {
			return nil, "", fmt.Errorf("云端转写失败（HTTP %d），请检查连接、余额或素材后重试", resp.StatusCode)
		}
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return nil, "", fmt.Errorf("本地转写服务返回 %d: %s", resp.StatusCode, strings.TrimSpace(string(msg)))
	}
	payload, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return nil, "", fmt.Errorf("读取转写结果失败: %w", err)
	}
	segments, languageOut, err := DecodeVerboseJSON(payload)
	if err != nil {
		return nil, "", err
	}
	if len(segments) == 0 {
		if c.Model == "" {
			return nil, "", fmt.Errorf("本地转写服务未识别出语音内容")
		}
		return nil, "", fmt.Errorf("转写服务未返回带时间的字幕，请检查素材是否包含语音")
	}
	return segments, languageOut, nil
}

func DecodeVerboseJSON(payload []byte) ([]Segment, string, error) {
	var parsed whisperVerboseJSON
	if err := json.Unmarshal(payload, &parsed); err != nil {
		return nil, "", fmt.Errorf("转写结果解析失败: %w", err)
	}
	segments := make([]Segment, 0, len(parsed.Segments))
	for _, seg := range parsed.Segments {
		if strings.TrimSpace(seg.Text) == "" {
			continue
		}
		segments = append(segments, Segment{
			StartMs: int64(math.Round(seg.Start * 1000)),
			EndMs:   int64(math.Round(seg.End * 1000)),
			Text:    strings.TrimSpace(seg.Text),
		})
	}
	return segments, parsed.Language, nil
}
