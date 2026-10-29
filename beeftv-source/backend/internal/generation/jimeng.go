package generation

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"infinite-canvas/backend/internal/outbound"

	"github.com/volcengine/volc-sdk-golang/base"
)

const (
	jiMengSubmitAction = "CVSync2AsyncSubmitTask"
	jiMengResultAction = "CVSync2AsyncGetResult"
	jiMengAPIVersion   = "2022-08-31"
)

const (
	JiMengSubmitAction = jiMengSubmitAction
	JiMengResultAction = jiMengResultAction
)

type JiMengResponse struct {
	Code      int    `json:"code"`
	Message   string `json:"message"`
	RequestID string `json:"request_id"`
	Data      struct {
		TaskID           string   `json:"task_id"`
		Status           string   `json:"status"`
		BinaryDataBase64 []string `json:"binary_data_base64"`
		ImageURLs        []string `json:"image_urls"`
		VideoURL         string   `json:"video_url"`
	} `json:"data"`
}

func IsVolcengineJiMengProtocol(protocol string) bool {
	return protocol == "volcengine-jimeng-image" || protocol == "volcengine-jimeng-video"
}

func RunVolcengineJiMengImageTask(ctx context.Context, input Input) (map[string]interface{}, error) {
	if input.Mask != nil {
		return nil, errors.New("即梦图片协议不支持蒙版编辑，请移除蒙版后重试")
	}
	body := map[string]interface{}{
		"req_key":      input.Config.Model,
		"prompt":       WithSystemPrompt(input.Config, input.Prompt),
		"force_single": true,
	}
	if width, height := JiMengImageDimensions(input.Config.Size); width > 0 && height > 0 {
		body["width"] = width
		body["height"] = height
	}
	if len(input.ReferenceImages) > 14 {
		return nil, errors.New("即梦图片协议最多支持 14 张参考图")
	}
	if len(input.ReferenceImages) > 0 {
		images := make([]string, 0, len(input.ReferenceImages))
		for _, image := range input.ReferenceImages {
			raw, _, err := MediaBytes(image)
			if err != nil {
				return nil, fmt.Errorf("读取即梦参考图失败：%w", err)
			}
			images = append(images, base64.StdEncoding.EncodeToString(raw))
		}
		body["binary_data_base64"] = images
	}

	taskID, err := SubmitJiMengTask(ctx, input.Config, body)
	if err != nil {
		return nil, err
	}
	for deadline := PollingDeadline(ctx); time.Now().Before(deadline); {
		result, err := PollJiMengTask(ctx, input.Config, taskID, `{"return_url":true}`)
		if err != nil {
			return nil, err
		}
		switch strings.ToLower(strings.TrimSpace(result.Data.Status)) {
		case "done":
			images, err := JiMengImageDataURLs(ctx, result)
			if err != nil {
				return nil, fmt.Errorf("即梦图片任务 %s 结果读取失败：%w", taskID, err)
			}
			return map[string]interface{}{"mode": "image", "images": images}, nil
		case "not_found", "expired":
			return nil, fmt.Errorf("即梦图片任务 %s 已失效，请重新生成", taskID)
		}
		if err := SleepContext(ctx, 3*time.Second); err != nil {
			return nil, err
		}
	}
	return nil, fmt.Errorf("即梦图片生成超时（任务 %s）", taskID)
}

func SubmitJiMengTask(ctx context.Context, config Config, body map[string]interface{}) (string, error) {
	if resumed := ResumedProviderRequestID(ctx); resumed != "" {
		return resumed, nil
	}
	var payload JiMengResponse
	if err := PostJiMengJSON(WithRequestKind(ctx, "create"), config, jiMengSubmitAction, body, &payload); err != nil {
		return "", err
	}
	if err := ValidateJiMengResponse(payload); err != nil {
		return "", err
	}
	taskID := strings.TrimSpace(payload.Data.TaskID)
	if taskID == "" {
		return "", errors.New("即梦接口没有返回任务 ID")
	}
	return taskID, nil
}

func PollJiMengTask(ctx context.Context, config Config, taskID string, reqJSON string) (JiMengResponse, error) {
	body := map[string]interface{}{"req_key": config.Model, "task_id": taskID}
	if reqJSON != "" {
		body["req_json"] = reqJSON
	}
	var payload JiMengResponse
	if err := PostJiMengJSON(WithRequestKind(ctx, "poll"), config, jiMengResultAction, body, &payload); err != nil {
		return payload, err
	}
	return payload, ValidateJiMengResponse(payload)
}

func PostJiMengJSON(ctx context.Context, config Config, action string, body interface{}, target interface{}) error {
	data, err := json.Marshal(body)
	if err != nil {
		return err
	}
	endpoint, err := url.Parse(strings.TrimSpace(config.BaseURL))
	if err != nil {
		return err
	}
	endpoint.Path = "/"
	query := endpoint.Query()
	query.Set("Action", action)
	query.Set("Version", jiMengAPIVersion)
	endpoint.RawQuery = query.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	outbound.ApplyOutboundHeaders(req, config.Headers)
	outbound.ApplyDefaultOutboundHeaders(req)
	credentials := base.Credentials{
		AccessKeyID:     strings.TrimSpace(config.APIKey),
		SecretAccessKey: strings.TrimSpace(config.SecretKey),
		Region:          "cn-north-1",
		Service:         "cv",
	}
	return DoJSON(credentials.Sign(req), target)
}

func ValidateJiMengResponse(payload JiMengResponse) error {
	if payload.Code == 10000 {
		return nil
	}
	message := strings.TrimSpace(payload.Message)
	if message == "" {
		message = "未知错误"
	}
	if payload.RequestID != "" {
		return fmt.Errorf("即梦接口返回错误 %d：%s（request_id: %s）", payload.Code, message, payload.RequestID)
	}
	return fmt.Errorf("即梦接口返回错误 %d：%s", payload.Code, message)
}

func JiMengImageDataURLs(ctx context.Context, payload JiMengResponse) ([]string, error) {
	images := make([]string, 0, len(payload.Data.ImageURLs)+len(payload.Data.BinaryDataBase64))
	for _, rawURL := range payload.Data.ImageURLs {
		data, mimeType, err := GetExternalBinary(WithRequestKind(ctx, "download"), rawURL)
		if err != nil {
			return nil, err
		}
		images = append(images, DataURL(NormalizedMediaMIMEType(mimeType, data), data))
	}
	for _, encoded := range payload.Data.BinaryDataBase64 {
		data, err := base64.StdEncoding.DecodeString(strings.TrimSpace(encoded))
		if err != nil {
			return nil, err
		}
		images = append(images, DataURL(NormalizedMediaMIMEType("image/png", data), data))
	}
	if len(images) == 0 {
		return nil, errors.New("任务已完成但没有返回图片")
	}
	return images, nil
}

func JiMengImageDimensions(value string) (int, int) {
	parts := strings.Split(strings.ToLower(NormalizePixelSize(value)), "x")
	if len(parts) != 2 {
		return 0, 0
	}
	width, widthErr := strconv.Atoi(parts[0])
	height, heightErr := strconv.Atoi(parts[1])
	if widthErr != nil || heightErr != nil || width <= 0 || height <= 0 {
		return 0, 0
	}
	area := int64(width) * int64(height)
	if area < 1024*1024 || area > 4096*4096 {
		return 0, 0
	}
	return width, height
}
