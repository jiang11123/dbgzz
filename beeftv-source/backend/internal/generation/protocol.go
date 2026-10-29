package generation

// 声明式协议插件宿主与接口类型校验。

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"net/textproto"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/modelcatalog"
	"infinite-canvas/backend/internal/outbound"
	"infinite-canvas/backend/internal/protocol"

	"github.com/google/uuid"
	"github.com/volcengine/volc-sdk-golang/base"
)

// runDeclarativeProtocolTask 是 JSON manifest 插件的宿主运行时。
// manifest 只能描述请求/响应映射；凭证、出站安全策略、轮询和结果下载必须由宿主统一掌握，
// 这样插件不能绕过服务端的鉴权、超时和 SSRF 防护边界。
func RunDeclarativeProtocolTask(ctx context.Context, input Input) (map[string]interface{}, error) {
	adapter, ok := DeclarativeProtocolAdapterForContext(ctx, input.Config.InterfaceType)
	if !ok {
		return nil, fmt.Errorf("接口类型 %s 未安装声明式适配器", input.Config.InterfaceType)
	}
	return RunProtocolAdapterTask(ctx, input, adapter)
}

func RunProtocolAdapterTask(ctx context.Context, input Input, adapter protocol.Adapter) (map[string]interface{}, error) {
	return RunProtocolAdapterTaskWithPolicy(ctx, input, adapter, DeclarativeProtocolPollPolicy(input.Mode))
}

func DeclarativeProtocolPollPolicy(mode string) VideoPollPolicy {
	if mode == "video" {
		return DefaultVideoPollPolicy()
	}
	return VideoPollPolicy{
		Interval:          2500 * time.Millisecond,
		MaxNotFoundMisses: 1,
		MaxDownloadTries:  3,
		Sleep:             SleepContext,
	}
}

func RunProtocolAdapterTaskWithPolicy(ctx context.Context, input Input, adapter protocol.Adapter, policy VideoPollPolicy) (map[string]interface{}, error) {
	if input.Mode == "video" {
		policy = videoPollPolicyForConfig(ctx, input.Config, policy)
	}
	// create、poll、download 是同一个外部任务的三个阶段：任一阶段失败都向上返回真实错误，
	// 不把“已提交但结果未知”伪装成成功，也不把下载失败降级成空结果。
	request := ProtocolRequestFromInput(input)
	taskID := ResumedProviderRequestID(ctx)
	var created protocol.CreateResult
	if taskID == "" {
		// 幂等键只存在于宿主请求元数据中，声明式插件可以把它映射到 Header，
		// 但不能把宿主控制字段泄漏到供应商 JSON body。恢复已有 taskID 时不会进入 create 分支。
		key := SubmissionKeyFromContext(ctx)
		if key == "" {
			key = uuid.NewString()
		}
		request.Extra["idempotencyKey"] = key
		spec, err := adapter.BuildCreate(ctx, protocol.RequestContext{BaseURL: input.Config.BaseURL, Request: request})
		if err != nil {
			return nil, err
		}
		if result, handled, streamErr := tryStreamingDeclarativeTextCreate(ctx, input, adapter, request, spec, policy); handled {
			return result, streamErr
		}
		var body []byte
		if input.Mode == "audio" {
			var mime string
			body, mime, err = ExecuteProtocolBinaryRequest(WithRequestKind(ctx, "create"), input.Config, spec)
			if err == nil && strings.Contains(strings.ToLower(mime), "text/event-stream") {
				body, mime, err = readSpeechAudioEvents(ctx, body)
			}
			if err == nil && input.Config.InterfaceType == string(model.ChannelInterfaceOpenAIAudio) {
				_, err = ValidateGeneratedAudio(mime, body, input.Config.AudioFormat)
			}
		} else {
			body, err = ExecuteProtocolRequest(WithRequestKind(ctx, "create"), input.Config, spec)
		}
		if err != nil {
			if input.Mode == "video" {
				return nil, UncertainVideoSubmission(ctx, err)
			}
			return nil, err
		}
		created, err = adapter.ParseCreate(ctx, body)
		if err != nil {
			if input.Mode == "video" {
				return nil, SubmissionUnknownError{Cause: err}
			}
			return nil, err
		}
		taskID = created.TaskID
		if taskID == "" {
			extracted, extractErr := ExtractProviderTaskID(body)
			if extractErr != nil {
				return nil, extractErr
			}
			taskID = extracted
		}
		if created.Status == protocol.StatusFailed || created.Status == protocol.StatusCancelled {
			return nil, ProtocolResultError(created.Message, taskID, body)
		}
		if created.Status == protocol.StatusSucceeded {
			return FinishProtocolAdapterResult(ctx, input, adapter, request, taskID, created.Result, policy)
		}
		if taskID == "" {
			return nil, SubmissionUnknownError{Cause: errors.New("创建请求未返回可查询的任务 ID，请核对供应商任务记录")}
		}
	}

	return RunVideoPollLoop(ctx, taskID, policy, func(ctx context.Context) (VideoPollOutcome, error) {
		spec, err := adapter.BuildPoll(ctx, protocol.PollContext{BaseURL: input.Config.BaseURL, Model: request.Model, Request: request, TaskID: taskID})
		if err != nil {
			return VideoPollOutcome{}, err
		}
		body, err := ExecuteProtocolRequest(WithRequestKind(ctx, "poll"), input.Config, spec)
		if err != nil {
			return VideoPollOutcome{}, err
		}
		state, err := adapter.ParsePoll(ctx, protocol.PollContext{BaseURL: input.Config.BaseURL, Model: request.Model, Request: request, TaskID: taskID}, body)
		if err != nil {
			return VideoPollOutcome{}, err
		}
		if state.TaskID != "" {
			taskID = state.TaskID
		}
		switch state.Status {
		case protocol.StatusSucceeded:
			result, err := FinishProtocolAdapterResult(ctx, input, adapter, request, taskID, state.Result, policy)
			return VideoPollOutcome{Done: err == nil, Result: result}, err
		case protocol.StatusFailed, protocol.StatusCancelled:
			return VideoPollOutcome{}, ProtocolResultError(state.Message, taskID, body)
		}
		return VideoPollOutcome{}, nil
	})
}

func ExtractProviderTaskID(body []byte) (string, error) {
	var payload map[string]interface{}
	if json.Unmarshal(body, &payload) != nil {
		return "", nil
	}
	id, err := firstJSONString(payload, "id", "task_id", "taskId", "request_id", "name")
	if id != "" {
		return id, nil
	}
	if data, ok := payload["data"].(map[string]interface{}); ok {
		nested, nestedErr := firstJSONString(data, "id", "task_id", "taskId", "request_id")
		if nested != "" {
			return nested, nil
		}
		if nestedErr != nil {
			return "", nestedErr
		}
	}
	return "", err
}

// queryProtocolAdapterVideoTask 只读取一次已有的声明式 Provider 任务。
// 人工恢复走此路径，因此检查本地失败任务时绝不会创建第二个上游任务。
func QueryProtocolAdapterVideoTask(ctx context.Context, input Input, adapter protocol.Adapter, taskID string) (map[string]interface{}, string, error) {
	request := ProtocolRequestFromInput(input)
	pollContext := protocol.PollContext{BaseURL: input.Config.BaseURL, Model: request.Model, Request: request, TaskID: taskID}
	spec, err := adapter.BuildPoll(ctx, pollContext)
	if err != nil {
		return nil, "", err
	}
	body, err := ExecuteProtocolRequest(WithRequestKind(ctx, "poll"), input.Config, spec)
	if err != nil {
		return nil, "", err
	}
	state, err := adapter.ParsePoll(ctx, pollContext, body)
	if err != nil {
		return nil, "", err
	}
	providerStatus := string(state.Status)
	switch state.Status {
	case protocol.StatusSucceeded:
		result, err := FinishProtocolAdapterResult(ctx, input, adapter, request, taskID, state.Result, DefaultVideoPollPolicy())
		return result, providerStatus, err
	case protocol.StatusFailed, protocol.StatusCancelled:
		return nil, providerStatus, ProtocolResultError(state.Message, taskID, body)
	case protocol.StatusPending, protocol.StatusProcessing:
		return nil, providerStatus, nil
	default:
		return nil, providerStatus, fmt.Errorf("声明式协议任务 %s 返回未知状态：%s", taskID, providerStatus)
	}
}

// tryStreamingDeclarativeTextCreate 让已知文本线协议在 Resolve 后的 StreamText 真正到达 OnTextDelta。
// 其它声明式插件仍走 JSON 创建；上游忽略 stream 并返回 JSON 时回退 ParseCreate。
func tryStreamingDeclarativeTextCreate(ctx context.Context, input Input, adapter protocol.Adapter, request protocol.GenerationRequest, spec protocol.RequestSpec, policy VideoPollPolicy) (map[string]interface{}, bool, error) {
	if input.Mode != "text" || !input.StreamText {
		return nil, false, nil
	}
	wire := streamingTextWire(input.Config.InterfaceType)
	if wire == "" {
		return nil, false, nil
	}
	body := ProtocolBodyObject(spec.Body)
	if body == nil {
		return nil, true, errors.New("声明式文本请求体必须是 JSON 对象")
	}
	body["stream"] = true
	if wire == "chat-completion" {
		if err := ensureChatCompletionStreamUsage(body); err != nil {
			return nil, true, err
		}
	}
	spec.Body = body
	parser := NewStreamingAgentParser(wire, input.OnTextDelta)
	parser.emitReasoning = input.OnReasoningDelta
	data, mime, err := ExecuteProtocolBinaryRequestWithConsumer(WithRequestKind(ctx, "create"), input.Config, spec, parser.Consume)
	if err != nil {
		return nil, true, err
	}
	if strings.Contains(strings.ToLower(mime), "event-stream") {
		parser.Flush()
		parsed, err := parser.Result()
		if err != nil {
			return nil, true, err
		}
		if strings.TrimSpace(stringField(parsed, "text")) == "" {
			return nil, true, errors.New("流式文本接口没有返回内容")
		}
		result := map[string]interface{}{"mode": "text", "text": stringField(parsed, "text")}
		if reasoning := strings.TrimSpace(stringField(parsed, "reasoning")); reasoning != "" {
			result["reasoning"] = reasoning
		}
		return result, true, nil
	}
	created, err := adapter.ParseCreate(ctx, data)
	if err != nil {
		return nil, true, err
	}
	taskID := created.TaskID
	if taskID == "" {
		if extracted, extractErr := ExtractProviderTaskID(data); extractErr == nil {
			taskID = extracted
		}
	}
	if created.Status == protocol.StatusFailed || created.Status == protocol.StatusCancelled {
		return nil, true, ProtocolResultError(created.Message, taskID, data)
	}
	if created.Status == protocol.StatusSucceeded {
		result, finishErr := FinishProtocolAdapterResult(ctx, input, adapter, request, taskID, created.Result, policy)
		return result, true, finishErr
	}
	return nil, true, SubmissionUnknownError{Cause: errors.New("流式文本创建未返回最终结果")}
}

func streamingTextWire(interfaceType string) string {
	switch strings.TrimSpace(interfaceType) {
	case "chat-completion":
		return "chat-completion"
	case string(model.ChannelInterfaceOpenAIResponse), "responses":
		return "responses"
	case string(model.ChannelInterfaceClaudeAPI):
		return "claude-api"
	default:
		return ""
	}
}

func ProtocolRequestFromInput(input Input) protocol.GenerationRequest {
	resolution := strings.TrimSpace(input.Config.VQuality)
	if input.Mode == "video" {
		if declared := videoResolutionNameRequest(input.VideoCapability, resolution); declared != "" {
			resolution = declared
		}
	}
	aspectRatio := strings.TrimSpace(input.Config.Size)
	if input.Mode == "image" {
		aspectRatio = ProtocolImageAspectRatio(input)
	}
	request := protocol.GenerationRequest{
		Capability:    protocol.Capability(input.Mode),
		Model:         input.Config.Model,
		Prompt:        input.Prompt,
		Instructions:  strings.TrimSpace(input.Config.SystemPrompt),
		Images:        ProtocolImageReferences(input),
		Videos:        ProtocolMediaReferences(input.ReferenceVideos, "video"),
		Audios:        ProtocolMediaReferences(input.ReferenceAudios, "audio"),
		AspectRatio:   aspectRatio,
		Resolution:    resolution,
		Quality:       input.Config.Quality,
		GenerateAudio: ParseBool(input.Config.VideoGenerateAudio, false),
		Watermark:     ParseBool(input.Config.VideoWatermark, false),
		Operation:     firstNonEmpty(metadataString(input.Metadata, "videoEditOperation"), metadataString(input.Metadata, "videoOperation")),
		Extra: map[string]any{
			"videoSeconds": input.Config.VideoSeconds,
			"audioVoice":   ResolvedAudioSpeechVoice(input.Config.Model, input.Config.AudioVoice),
			"audioFormat":  defaultString(input.Config.AudioFormat, "mp3"),
			"audioSpeed":   defaultString(input.Config.AudioSpeed, "1"),
			"count":        input.Config.Count,
		},
	}
	if input.Mode == "audio" && strings.Contains(strings.ToLower(input.Config.Model), "minimax-music-") {
		request.Extra["audioFormat"] = "mp3"
		request.Extra["audioMetadata"] = map[string]any{"audio_setting": map[string]any{"sample_rate": 44100, "bitrate": 256000, "format": "mp3"}}
		if isBeefAPIHostFromURL(input.Config.BaseURL) {
			request.Extra["audioStreamFormat"] = "sse"
		}
	}
	for _, message := range input.TextHistory {
		role := strings.ToLower(strings.TrimSpace(message.Role))
		if role != "user" && role != "assistant" && role != "system" {
			continue
		}
		if content := strings.TrimSpace(message.Content); content != "" {
			request.Messages = append(request.Messages, protocol.Message{Role: role, Content: content})
		}
	}
	request.Inputs = append(request.Inputs, request.Images...)
	request.Inputs = append(request.Inputs, request.Videos...)
	request.Inputs = append(request.Inputs, request.Audios...)
	if input.MaxOutputTokens > 0 {
		request.Extra["max_output_tokens"] = input.MaxOutputTokens
		request.Extra["max_tokens"] = input.MaxOutputTokens
	}
	if duration, err := strconv.Atoi(strings.TrimSpace(input.Config.VideoSeconds)); err == nil && (duration > 0 || (duration == -1 && model.IsVolcengineArkVideoProtocol(model.ChannelInterfaceType(input.Config.InterfaceType)))) {
		request.Duration = duration
	}
	if count, err := strconv.Atoi(strings.TrimSpace(input.Config.Count)); err == nil && count > 0 {
		request.ImageCount = count
	}
	request.Output = protocol.OutputOptions{
		Count: request.ImageCount, Duration: request.Duration, AspectRatio: request.AspectRatio,
		Resolution: request.Resolution, Quality: request.Quality, GenerateAudio: request.GenerateAudio,
		Watermark: request.Watermark, Format: input.Config.AudioFormat,
	}
	if instructions := strings.TrimSpace(input.Config.AudioInstructions); instructions != "" {
		request.Extra["audioInstructions"] = instructions
	}
	request.ProviderOptions = make(map[string]map[string]any)
	if configured, ok := input.Metadata["providerOptions"].(map[string]any); ok {
		for namespace, raw := range configured {
			if options, ok := raw.(map[string]any); ok {
				request.ProviderOptions[strings.TrimSpace(namespace)] = options
			}
		}
	}
	if input.Mode == "video" && usesSeedanceTaskOptions(input.Config) {
		request = protocol.NormalizeSeedanceTaskOptions(request)
	}
	return request
}

// protocolImageAspectRatio keeps the canvas size for protocol AspectRatio unless
// the capability field is size and the adapter copies that value onto body.size
// with no ratio table of its own (openai-images).
func ProtocolImageAspectRatio(input Input) string {
	raw := strings.TrimSpace(input.Config.Size)
	key, value := ImageSizeParameter(input.ImageCapability, input.Config.Size)
	if key != "size" || value == "" {
		return raw
	}
	if strings.TrimSpace(input.Config.InterfaceType) != string(model.ChannelInterfaceOpenAIImage) {
		return raw
	}
	return value
}

func ProtocolImageReferences(input Input) []protocol.MediaReference {
	if input.Mode == "video" {
		return ProtocolVideoImageReferences(input)
	}
	result := make([]protocol.MediaReference, 0, len(input.ReferenceImages)+1)
	for index, value := range input.ReferenceImages {
		item := ProtocolMediaReference(value, "image", index)
		item.Role = "reference_image"
		if input.Mode == "image" {
			item.Role = "edit_source"
		}
		if item.URL != "" || item.DataURL != "" {
			result = append(result, item)
		}
	}
	if input.Mask != nil {
		mask := ProtocolMediaReference(*input.Mask, "image", len(result))
		mask.Role = "mask"
		if mask.URL != "" || mask.DataURL != "" {
			result = append(result, mask)
		}
	}
	return result
}

func ProtocolVideoImageReferences(input Input) []protocol.MediaReference {
	result := make([]protocol.MediaReference, 0, len(input.ReferenceImages))
	fallbackRole := ""
	if metadataString(input.Metadata, "videoStartFrameNodeId") != "" || metadataString(input.Metadata, "videoEndFrameNodeId") != "" {
		fallbackRole = "reference_image"
	}
	for index, value := range input.ReferenceImages {
		item := ProtocolMediaReference(value, "image", index)
		item.Role = VideoImageRoleOrDefault(input, value, fallbackRole)
		if modelcatalog.IsSeedance25Model(input.Config.Model) && item.Role == "" && usesSeedanceTaskOptions(input.Config) {
			item.Role = SeedanceTaskImageRole(input, value)
		}
		if item.URL != "" || item.DataURL != "" {
			result = append(result, item)
		}
	}
	return result
}

func ProtocolMediaReferences(values []Media, kind string) []protocol.MediaReference {
	result := make([]protocol.MediaReference, 0, len(values))
	for index, value := range values {
		item := ProtocolMediaReference(value, kind, index)
		if kind == "video" {
			item.Role = "reference_video"
		} else if kind == "audio" {
			item.Role = "reference_audio"
		}
		if item.URL != "" || item.DataURL != "" {
			result = append(result, item)
		}
	}
	return result
}

func ProtocolMediaReference(value Media, kind string, order int) protocol.MediaReference {
	return protocol.MediaReference{
		ID: strings.TrimSpace(value.ID), URL: strings.TrimSpace(value.URL), DataURL: strings.TrimSpace(value.DataURL),
		Kind: kind, MIMEType: firstNonEmpty(strings.TrimSpace(value.MimeType), strings.TrimSpace(value.Type)), Name: strings.TrimSpace(value.Name), Order: order,
		Metadata: map[string]any{"bytes": value.Bytes, "width": value.Width, "height": value.Height, "durationMs": value.DurationMs, "storageKey": strings.TrimSpace(value.StorageKey)},
	}
}

func ExecuteProtocolRequest(ctx context.Context, config Config, spec protocol.RequestSpec) ([]byte, error) {
	data, _, err := ExecuteProtocolBinaryRequest(ctx, config, spec)
	return data, err
}

// executeProtocolBinaryRequest 是声明式插件与宿主网络能力之间的边界。manifest 只能声明
// method/path/body/auth；最终 URL 校验、凭证注入、SSRF、超时、大小限制和审计仍由宿主统一执行，
// 插件不能通过自定义请求规格绕过这些安全约束。
func ExecuteProtocolBinaryRequest(ctx context.Context, config Config, spec protocol.RequestSpec) ([]byte, string, error) {
	return ExecuteProtocolBinaryRequestWithConsumer(ctx, config, spec, nil)
}

func ExecuteProtocolBinaryRequestWithConsumer(ctx context.Context, config Config, spec protocol.RequestSpec, consume func(string, []byte)) ([]byte, string, error) {
	if err := spec.Validate(); err != nil {
		return nil, "", err
	}
	method := strings.ToUpper(strings.TrimSpace(spec.Method))
	body, contentType, err := ProtocolRequestBody(ctx, config, spec)
	if err != nil {
		return nil, "", RequestPreparationError{Cause: err}
	}
	requestURL, err := ProtocolRequestURL(config.BaseURL, spec)
	if err != nil {
		return nil, "", err
	}
	req, err := http.NewRequestWithContext(ctx, method, requestURL, body)
	if err != nil {
		return nil, "", err
	}
	if method == http.MethodPut && contentType == "application/octet-stream" && req.Body != nil {
		req.Body = io.NopCloser(referenceUploadReader(ctx, req.Body))
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	idle, _ := ctx.Value(videoDeliveryRequestContext{}).(time.Duration)
	if idle == 0 || SameProviderOrigin(config.BaseURL, requestURL) {
		for name, value := range spec.Headers {
			req.Header.Set(name, value)
		}
		outbound.ApplyOutboundHeaders(req, config.Headers)
		if err := ApplyProtocolAuth(req, config, spec.Auth); err != nil {
			return nil, "", err
		}
	}
	applyBeefAPIVideoDeliveryHeader(ctx, config, req)
	if consume != nil {
		req.Header.Set("Accept", "text/event-stream")
		return DoBinaryWithConsumer(req, consume)
	}
	return DoBinary(req)
}

func ProtocolRequestBody(ctx context.Context, config Config, spec protocol.RequestSpec) (io.Reader, string, error) {
	contentType := strings.ToLower(strings.TrimSpace(strings.Split(spec.ContentType, ";")[0]))
	if spec.Body == nil && len(spec.Files) == 0 {
		return nil, "", nil
	}
	switch contentType {
	case "", "application/json":
		data, err := json.Marshal(spec.Body)
		if err != nil {
			return nil, "", err
		}
		// Ark documents a 64 MiB JSON request limit. Measure the actual wire
		// representation, including base64; URL resource sizes are irrelevant.
		if model.IsVolcengineArkVideoProtocol(model.ChannelInterfaceType(config.InterfaceType)) && int64(len(data)) > VideoJSONRequestLimitBytes {
			return nil, "", ErrVideoJSONRequestTooLarge
		}
		return bytes.NewReader(data), "application/json", nil
	case "application/x-www-form-urlencoded":
		values := url.Values{}
		for key, value := range ProtocolBodyObject(spec.Body) {
			for _, item := range ProtocolFormValues(value) {
				values.Add(key, item)
			}
		}
		return strings.NewReader(values.Encode()), contentType, nil
	case "multipart/form-data":
		var body bytes.Buffer
		writer := multipart.NewWriter(&body)
		keys := make([]string, 0)
		for key := range ProtocolBodyObject(spec.Body) {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			for _, item := range ProtocolFormValues(ProtocolBodyObject(spec.Body)[key]) {
				if err := writer.WriteField(key, item); err != nil {
					_ = writer.Close()
					return nil, "", err
				}
			}
		}
		for _, file := range spec.Files {
			data, detectedMIME, err := ProtocolMediaBytes(ctx, config, file.Reference)
			if err != nil {
				_ = writer.Close()
				return nil, "", fmt.Errorf("读取 multipart 文件 %s 失败：%w", file.Name, err)
			}
			filename := SafeProtocolFilename(file.Filename)
			mimeType := strings.TrimSpace(file.MIMEType)
			if mimeType == "" {
				mimeType = detectedMIME
			}
			header := make(textproto.MIMEHeader)
			header.Set("Content-Disposition", fmt.Sprintf(`form-data; name=%q; filename=%q`, file.Name, filename))
			header.Set("Content-Type", defaultString(mimeType, "application/octet-stream"))
			part, err := writer.CreatePart(header)
			if err != nil {
				_ = writer.Close()
				return nil, "", err
			}
			if _, err := part.Write(data); err != nil {
				_ = writer.Close()
				return nil, "", err
			}
		}
		if err := writer.Close(); err != nil {
			return nil, "", err
		}
		return bytes.NewReader(body.Bytes()), writer.FormDataContentType(), nil
	case "application/octet-stream":
		switch value := spec.Body.(type) {
		case []byte:
			return bytes.NewReader(value), contentType, nil
		case string:
			if strings.HasPrefix(value, "data:") {
				mimeType, data, err := DecodeProviderDataURL(value)
				if err != nil {
					return nil, "", err
				}
				return bytes.NewReader(data), defaultString(mimeType, contentType), nil
			}
			return strings.NewReader(value), contentType, nil
		default:
			return nil, "", fmt.Errorf("二进制协议请求体必须是字节或字符串")
		}
	default:
		return nil, "", fmt.Errorf("声明式协议暂不支持 %s 请求体", spec.ContentType)
	}
}

func ProtocolBodyObject(value any) map[string]any {
	result, _ := value.(map[string]any)
	return result
}

func ProtocolFormValues(value any) []string {
	switch typed := value.(type) {
	case nil:
		return nil
	case []any:
		result := make([]string, 0, len(typed))
		for _, item := range typed {
			result = append(result, ProtocolFormValues(item)...)
		}
		return result
	case string:
		return []string{typed}
	case bool:
		return []string{strconv.FormatBool(typed)}
	case float64:
		return []string{strconv.FormatFloat(typed, 'f', -1, 64)}
	case int:
		return []string{strconv.Itoa(typed)}
	default:
		data, err := json.Marshal(typed)
		if err != nil {
			return nil
		}
		return []string{string(data)}
	}
}

func SafeProtocolFilename(value string) string {
	value = strings.TrimSpace(value)
	if index := strings.LastIndexAny(value, `/\\`); index >= 0 {
		value = value[index+1:]
	}
	value = strings.Map(func(r rune) rune {
		if r < 32 || r == 127 || r == '"' {
			return -1
		}
		return r
	}, value)
	if value == "" {
		return "upload.bin"
	}
	return value
}

func ApplyProtocolAuth(req *http.Request, config Config, auth protocol.ManifestAuth) error {
	typeName := strings.ToLower(strings.TrimSpace(auth.Type))
	if typeName == "" {
		ApplyAuth(req, config)
		return nil
	}
	credential := ProtocolCredentialField(config, auth.Field)
	if idle, _ := req.Context().Value(videoDeliveryRequestContext{}).(time.Duration); idle > 0 {
		credentials, _ := req.Context().Value(videoCredentialContext{}).(videoProviderCredentials)
		credentials.Origin = config.BaseURL
		credentials.Values = append(credentials.Values, credential, auth.Prefix+credential, ProtocolCredentialField(config, auth.SecretField))
		*req = *req.WithContext(context.WithValue(req.Context(), videoCredentialContext{}, credentials))
	}
	switch typeName {
	case "none":
		return nil
	case "bearer":
		header := defaultString(strings.TrimSpace(auth.Header), "Authorization")
		prefix := auth.Prefix
		if prefix == "" {
			prefix = "Bearer "
		}
		req.Header.Set(header, prefix+credential)
		return nil
	case "header", "api-key", "apikey":
		header := strings.TrimSpace(auth.Header)
		if header == "" {
			return errors.New("插件 header 鉴权缺少 header 名称")
		}
		req.Header.Set(header, auth.Prefix+credential)
		return nil
	case "query":
		name := defaultString(strings.TrimSpace(auth.Query), strings.TrimSpace(auth.Field))
		if name == "" {
			return errors.New("插件 query 鉴权缺少参数名")
		}
		if idle, _ := req.Context().Value(videoDeliveryRequestContext{}).(time.Duration); idle > 0 {
			setVideoCredentialQuery(req.URL, name, auth.Prefix+credential)
			return nil
		}
		query := req.URL.Query()
		query.Set(name, auth.Prefix+credential)
		req.URL.RawQuery = query.Encode()
		return nil
	case "basic":
		username := auth.Username
		if username == "" {
			username = credential
		}
		password := ProtocolCredentialField(config, auth.SecretField)
		req.SetBasicAuth(username, password)
		return nil
	case "anthropic":
		req.Header.Set(defaultString(auth.Header, "x-api-key"), credential)
		if req.Header.Get("anthropic-version") == "" {
			req.Header.Set("anthropic-version", "2023-06-01")
		}
		return nil
	case "google-api-key", "gemini":
		req.Header.Set(defaultString(auth.Header, "x-goog-api-key"), credential)
		return nil
	case "volcengine-v4":
		secret := ProtocolCredentialField(config, auth.SecretField)
		if credential == "" || secret == "" {
			return errors.New("火山引擎 V4 鉴权需要 Access Key 和 Secret Key")
		}
		credentials := base.Credentials{
			AccessKeyID: credential, SecretAccessKey: secret,
			Region:  defaultString(strings.TrimSpace(auth.Region), "cn-north-1"),
			Service: strings.TrimSpace(auth.Service),
		}
		if credentials.Service == "" {
			return errors.New("火山引擎 V4 鉴权缺少 service")
		}
		signed := credentials.Sign(req)
		*req = *signed
		return nil
	case "aws-sigv4":
		secret := ProtocolCredentialField(config, auth.SecretField)
		return SignProtocolAWSV4(req, credential, secret, auth)
	case "tc3":
		secret := ProtocolCredentialField(config, auth.SecretField)
		return SignProtocolTC3(req, credential, secret, auth)
	default:
		return fmt.Errorf("插件声明了尚未启用的鉴权驱动 %s", auth.Type)
	}
}

func SignProtocolAWSV4(req *http.Request, accessKey, secretKey string, auth protocol.ManifestAuth) error {
	if strings.TrimSpace(accessKey) == "" || strings.TrimSpace(secretKey) == "" {
		return errors.New("AWS SigV4 鉴权需要 Access Key ID 和 Secret Access Key")
	}
	serviceName := defaultString(strings.TrimSpace(auth.Service), "bedrock")
	region := strings.TrimSpace(auth.Region)
	if region == "" {
		parts := strings.Split(strings.ToLower(req.URL.Hostname()), ".")
		for index, part := range parts {
			if strings.HasPrefix(part, serviceName) && index+1 < len(parts) {
				region = parts[index+1]
				break
			}
		}
	}
	if region == "" {
		return errors.New("AWS SigV4 鉴权无法从 Base URL 推断 region，请使用包含区域的 Bedrock Runtime 地址")
	}
	payload, err := ProtocolRequestPayload(req)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	amzDate := now.Format("20060102T150405Z")
	dateStamp := now.Format("20060102")
	payloadHash := Sha256Hex(payload)
	req.Header.Set("X-Amz-Date", amzDate)
	req.Header.Set("X-Amz-Content-Sha256", payloadHash)
	canonicalHeaders, signedHeaders := ProtocolCanonicalHeaders(req)
	canonicalRequest := strings.Join([]string{
		req.Method,
		defaultString(req.URL.EscapedPath(), "/"),
		req.URL.Query().Encode(),
		canonicalHeaders,
		signedHeaders,
		payloadHash,
	}, "\n")
	scope := strings.Join([]string{dateStamp, region, serviceName, "aws4_request"}, "/")
	stringToSign := strings.Join([]string{"AWS4-HMAC-SHA256", amzDate, scope, Sha256Hex([]byte(canonicalRequest))}, "\n")
	dateKey := ProtocolHMAC([]byte("AWS4"+secretKey), dateStamp)
	regionKey := ProtocolHMAC(dateKey, region)
	serviceKey := ProtocolHMAC(regionKey, serviceName)
	signingKey := ProtocolHMAC(serviceKey, "aws4_request")
	signature := hex.EncodeToString(ProtocolHMAC(signingKey, stringToSign))
	req.Header.Set("Authorization", fmt.Sprintf("AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s", accessKey, scope, signedHeaders, signature))
	return nil
}

func SignProtocolTC3(req *http.Request, secretID, secretKey string, auth protocol.ManifestAuth) error {
	if strings.TrimSpace(secretID) == "" || strings.TrimSpace(secretKey) == "" {
		return errors.New("腾讯云 TC3 鉴权需要 SecretId 和 SecretKey")
	}
	serviceName := defaultString(strings.TrimSpace(auth.Service), "hunyuan")
	payload, err := ProtocolRequestPayload(req)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	timestamp := now.Unix()
	dateStamp := now.Format("2006-01-02")
	contentType := defaultString(req.Header.Get("Content-Type"), "application/json")
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("X-TC-Timestamp", strconv.FormatInt(timestamp, 10))
	if region := strings.TrimSpace(auth.Region); region != "" {
		req.Header.Set("X-TC-Region", region)
	}
	canonicalHeaders := "content-type:" + strings.ToLower(strings.TrimSpace(contentType)) + "\n" + "host:" + strings.ToLower(req.URL.Host) + "\n"
	signedHeaders := "content-type;host"
	canonicalRequest := strings.Join([]string{req.Method, defaultString(req.URL.EscapedPath(), "/"), req.URL.Query().Encode(), canonicalHeaders, signedHeaders, Sha256Hex(payload)}, "\n")
	scope := dateStamp + "/" + serviceName + "/tc3_request"
	stringToSign := strings.Join([]string{"TC3-HMAC-SHA256", strconv.FormatInt(timestamp, 10), scope, Sha256Hex([]byte(canonicalRequest))}, "\n")
	secretDate := ProtocolHMAC([]byte("TC3"+secretKey), dateStamp)
	secretService := ProtocolHMAC(secretDate, serviceName)
	secretSigning := ProtocolHMAC(secretService, "tc3_request")
	signature := hex.EncodeToString(ProtocolHMAC(secretSigning, stringToSign))
	req.Header.Set("Authorization", fmt.Sprintf("TC3-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s", secretID, scope, signedHeaders, signature))
	return nil
}

func ProtocolRequestPayload(req *http.Request) ([]byte, error) {
	if req.Body == nil {
		return nil, nil
	}
	var reader io.ReadCloser
	var err error
	if req.GetBody != nil {
		reader, err = req.GetBody()
	} else {
		reader = req.Body
	}
	if err != nil {
		return nil, err
	}
	data, err := io.ReadAll(reader)
	if req.GetBody != nil {
		_ = reader.Close()
	} else {
		req.Body = io.NopCloser(bytes.NewReader(data))
	}
	return data, err
}

func ProtocolCanonicalHeaders(req *http.Request) (string, string) {
	values := map[string]string{"host": strings.ToLower(req.URL.Host)}
	for name, entries := range req.Header {
		lower := strings.ToLower(strings.TrimSpace(name))
		if lower == "authorization" || lower == "user-agent" || lower == "content-length" || lower == "expect" {
			continue
		}
		cleaned := make([]string, 0, len(entries))
		for _, entry := range entries {
			cleaned = append(cleaned, strings.Join(strings.Fields(entry), " "))
		}
		values[lower] = strings.Join(cleaned, ",")
	}
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var canonical strings.Builder
	for _, key := range keys {
		canonical.WriteString(key)
		canonical.WriteByte(':')
		canonical.WriteString(values[key])
		canonical.WriteByte('\n')
	}
	return canonical.String(), strings.Join(keys, ";")
}

func ProtocolHMAC(key []byte, value string) []byte {
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(value))
	return mac.Sum(nil)
}

func Sha256Hex(value []byte) string {
	hash := sha256.Sum256(value)
	return hex.EncodeToString(hash[:])
}

func ProtocolCredentialField(config Config, field string) string {
	switch strings.ToLower(strings.TrimSpace(field)) {
	case "secretkey", "secret_key", "secret":
		return strings.TrimSpace(config.SecretKey)
	default:
		return strings.TrimSpace(config.APIKey)
	}
}

func ProtocolRequestURL(baseURL string, spec protocol.RequestSpec) (string, error) {
	if !spec.OriginPath {
		return AppendProtocolQuery(APIURL(baseURL, spec.Path), spec.Query)
	}
	base, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil || base.Scheme == "" || base.Host == "" {
		return "", fmt.Errorf("协议根路径请求的 Base URL 无效")
	}
	requestPath, err := url.Parse(spec.Path)
	if err != nil || !strings.HasPrefix(requestPath.Path, "/") {
		return "", fmt.Errorf("协议根路径请求必须使用绝对路径")
	}
	base.Path = requestPath.Path
	base.RawPath = requestPath.RawPath
	base.RawQuery = requestPath.RawQuery
	base.Fragment = ""
	return AppendProtocolQuery(base.String(), spec.Query)
}

func AppendProtocolQuery(rawURL string, values map[string][]string) (string, error) {
	if len(values) == 0 {
		return rawURL, nil
	}
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return "", err
	}
	query := parsed.Query()
	for key, items := range values {
		for _, item := range items {
			query.Add(key, item)
		}
	}
	parsed.RawQuery = query.Encode()
	return parsed.String(), nil
}

func FinishProtocolResult(ctx context.Context, config Config, mode string, taskID string, result *protocol.Result, pollPolicy VideoPollPolicy) (map[string]interface{}, error) {
	return finishProtocolResult(ctx, config, mode, taskID, result, pollPolicy, nil)
}

func finishProtocolResult(ctx context.Context, config Config, mode string, taskID string, result *protocol.Result, pollPolicy VideoPollPolicy, renew func(context.Context, int) (VideoResultSource, error)) (map[string]interface{}, error) {
	if mode == "video" {
		pollPolicy = videoPollPolicyForConfig(ctx, config, pollPolicy)
	}
	if result == nil {
		return nil, errors.New("声明式协议已完成但没有返回结果")
	}
	if mode == "text" {
		output := map[string]interface{}{"mode": "text", "text": result.Text}
		if strings.TrimSpace(result.Reasoning) != "" {
			output["reasoning"] = result.Reasoning
		}
		return output, nil
	}
	var references []protocol.MediaReference
	switch mode {
	case "image":
		references = result.Images
	case "video":
		references = result.Videos
	case "audio":
		references = result.Audios
	default:
		return nil, fmt.Errorf("声明式协议不支持生成模式 %s", mode)
	}
	if len(references) == 0 {
		return nil, errors.New("声明式协议已完成但没有返回媒体地址")
	}
	items := make([]interface{}, 0, len(references))
	for index, reference := range references {
		if mode == "image" && strings.TrimSpace(reference.DataURL) == "" && strings.TrimSpace(reference.URL) != "" {
			value := strings.TrimSpace(reference.URL)
			if _, err := outbound.ValidateOutboundURL(value); err != nil {
				return nil, err
			}
			// Generation is complete. Persist its artifact before the existing
			// delivery worker downloads it; a slow GET must not fail a paid create.
			items = append(items, map[string]interface{}{"url": value, "mimeType": reference.MIMEType})
			continue
		}
		var data []byte
		var mimeType string
		var err error
		if mode == "video" {
			var resolve videoResultResolver
			if renew != nil {
				resolve = func(ctx context.Context) (VideoResultSource, error) { return renew(ctx, index) }
			}
			source := videoURLSource(config, defaultString(reference.DataURL, reference.URL))
			download := VideoResultDownloader(config, taskID, source, resolve)
			data, mimeType, err = RunVideoDownload(ctx, taskID, pollPolicy, download)
		} else {
			data, mimeType, err = ProtocolMediaBytes(ctx, config, reference)
		}
		if err != nil {
			return nil, err
		}
		mimeType = NormalizedMediaMIMEType(mimeType, data)
		item := map[string]interface{}{"dataUrl": DataURL(mimeType, data), "mimeType": mimeType}
		items = append(items, item)
	}
	switch mode {
	case "image":
		return map[string]interface{}{"mode": "image", "images": items}, nil
	case "video":
		return map[string]interface{}{"mode": "video", "video": items[0]}, nil
	default:
		return map[string]interface{}{"mode": "audio", "audio": items[0]}, nil
	}
}

// finishProtocolAdapterResult 优先消费 create/poll 已返回的内联或 URL 结果，只有插件明确声明独立结果端点时才下载。
// 空响应或下载失败必须向上失败，不能生成伪素材；application/octet-stream 仅表示传输层未知类型，
// 不会把未知内容伪装成具体图片、视频或音频 MIME。
func FinishProtocolAdapterResult(ctx context.Context, input Input, adapter protocol.Adapter, request protocol.GenerationRequest, taskID string, result *protocol.Result, pollPolicy VideoPollPolicy) (map[string]interface{}, error) {
	if input.Mode == "video" {
		pollPolicy = videoPollPolicyForConfig(ctx, input.Config, pollPolicy)
		if auth, ok := adapter.(protocol.MediaAuthAdapter); ok {
			ctx = withVideoProtocolAuth(ctx, auth.MediaAuth())
		}
	}
	renew := func(ctx context.Context, index int) (VideoResultSource, error) {
		referenceID := ""
		if result != nil && index < len(result.Videos) {
			referenceID = strings.TrimSpace(result.Videos[index].ID)
		}
		return queryProtocolVideoSource(ctx, input, adapter, request, taskID, index, referenceID)
	}
	if ProtocolResultHasOutput(input.Mode, result) {
		return finishProtocolResult(ctx, input.Config, input.Mode, taskID, result, pollPolicy, renew)
	}
	resultAdapter, ok := adapter.(protocol.ResultAdapter)
	capability, hasCapability := adapter.(protocol.ResultCapability)
	if !ok || !hasCapability || !capability.ResultAvailable() {
		return FinishProtocolResult(ctx, input.Config, input.Mode, taskID, result, pollPolicy)
	}
	spec, err := resultAdapter.BuildResult(ctx, protocol.PollContext{BaseURL: input.Config.BaseURL, Model: request.Model, Request: request, TaskID: taskID})
	if err != nil {
		return nil, err
	}
	download := func(ctx context.Context) ([]byte, string, error) {
		return ExecuteProtocolBinaryRequest(WithRequestKind(ctx, "download"), input.Config, spec)
	}
	if input.Mode == "video" {
		source, sourceErr := protocolVideoRequestSource(input.Config, spec)
		if sourceErr != nil {
			return nil, sourceErr
		}
		download = VideoResultDownloader(input.Config, taskID, source, func(ctx context.Context) (VideoResultSource, error) { return renew(ctx, 0) })
	}
	var data []byte
	var mimeType string
	if input.Mode == "video" {
		data, mimeType, err = RunVideoDownload(ctx, taskID, pollPolicy, download)
	} else {
		data, mimeType, err = download(ctx)
	}
	if err != nil {
		return nil, fmt.Errorf("声明式协议结果下载失败：%w", err)
	}
	if len(data) == 0 {
		return nil, errors.New("声明式协议结果下载返回空内容")
	}
	mimeType = strings.TrimSpace(strings.Split(mimeType, ";")[0])
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	reference := protocol.MediaReference{DataURL: DataURL(mimeType, data), MIMEType: mimeType}
	downloaded := &protocol.Result{}
	switch input.Mode {
	case "image":
		downloaded.Images = []protocol.MediaReference{reference}
	case "video":
		downloaded.Videos = []protocol.MediaReference{reference}
	case "audio":
		downloaded.Audios = []protocol.MediaReference{reference}
	default:
		return nil, fmt.Errorf("声明式协议结果下载不支持生成模式 %s", input.Mode)
	}
	return FinishProtocolResult(ctx, input.Config, input.Mode, taskID, downloaded, pollPolicy)
}

func protocolVideoRequestSource(config Config, spec protocol.RequestSpec) (VideoResultSource, error) {
	rawURL, err := ProtocolRequestURL(config.BaseURL, spec)
	if err != nil {
		return VideoResultSource{}, err
	}
	return VideoResultSource{URL: rawURL, Read: func(ctx context.Context) ([]byte, string, error) {
		return ExecuteProtocolBinaryRequest(withVideoProtocolAuth(WithRequestKind(ctx, "download"), spec.Auth), config, spec)
	}}, nil
}

func queryProtocolVideoSource(ctx context.Context, input Input, adapter protocol.Adapter, request protocol.GenerationRequest, taskID string, index int, referenceID string) (VideoResultSource, error) {
	pollContext := protocol.PollContext{BaseURL: input.Config.BaseURL, Model: request.Model, Request: request, TaskID: taskID}
	spec, err := adapter.BuildPoll(ctx, pollContext)
	if err != nil {
		return VideoResultSource{}, err
	}
	body, err := ExecuteProtocolRequest(WithRequestKind(ctx, "poll"), input.Config, spec)
	if err != nil {
		return VideoResultSource{}, err
	}
	state, err := adapter.ParsePoll(ctx, pollContext, body)
	if err != nil {
		return VideoResultSource{}, err
	}
	if returnedID := strings.TrimSpace(state.TaskID); returnedID != "" && returnedID != strings.TrimSpace(taskID) {
		return VideoResultSource{}, errors.New("查询结果与原视频任务不一致，已停止取回")
	}
	if state.Status == protocol.StatusFailed || state.Status == protocol.StatusCancelled {
		return VideoResultSource{}, ProtocolResultError(state.Message, taskID, body)
	}
	if state.Status != protocol.StatusSucceeded {
		_, err := videoResultURL(string(state.Status), "")
		return VideoResultSource{}, err
	}
	var reference protocol.MediaReference
	found := false
	if state.Result != nil {
		if referenceID != "" {
			for _, candidate := range state.Result.Videos {
				if strings.TrimSpace(candidate.ID) == referenceID {
					if found {
						return VideoResultSource{}, errors.New("原视频任务返回重复的产物 ID，已停止取回")
					}
					reference, found = candidate, true
				}
			}
		} else if index >= 0 && index < len(state.Result.Videos) {
			reference, found = state.Result.Videos[index], true
		}
	}
	if found {
		rawURL, err := videoResultURL("succeeded", defaultString(reference.DataURL, reference.URL))
		return videoURLSource(input.Config, rawURL), err
	}
	if referenceID != "" || index != 0 {
		return VideoResultSource{}, errors.New("原视频任务没有返回对应视频产物，已停止取回")
	}
	resultAdapter, ok := adapter.(protocol.ResultAdapter)
	capability, capable := adapter.(protocol.ResultCapability)
	if !ok || !capable || !capability.ResultAvailable() {
		return VideoResultSource{}, errors.New("原视频任务没有返回可取回的结果")
	}
	spec, err = resultAdapter.BuildResult(ctx, pollContext)
	if err != nil {
		return VideoResultSource{}, err
	}
	return protocolVideoRequestSource(input.Config, spec)
}

func ProtocolResultHasOutput(mode string, result *protocol.Result) bool {
	if result == nil {
		return false
	}
	switch mode {
	case "text":
		return strings.TrimSpace(result.Text) != ""
	case "image":
		return len(result.Images) > 0
	case "video":
		return len(result.Videos) > 0
	case "audio":
		return len(result.Audios) > 0
	default:
		return false
	}
}

func ProtocolMediaBytes(ctx context.Context, config Config, reference protocol.MediaReference) ([]byte, string, error) {
	var data []byte
	var mimeType string
	var err error
	for attempt := 0; attempt < 3; attempt++ {
		data, mimeType, err = ProtocolMediaBytesOnce(ctx, config, reference)
		if err == nil {
			return data, mimeType, nil
		}
		if attempt == 2 || !RetryableProtocolMediaDownload(err) {
			break
		}
		if waitErr := SleepContext(ctx, time.Duration(attempt+1)*time.Second); waitErr != nil {
			return nil, "", fmt.Errorf("声明式协议媒体结果下载失败：%w", waitErr)
		}
	}
	return nil, "", fmt.Errorf("声明式协议媒体结果下载失败：%w", err)
}

func ProtocolMediaBytesOnce(ctx context.Context, config Config, reference protocol.MediaReference) ([]byte, string, error) {
	if strings.TrimSpace(reference.DataURL) != "" {
		mimeType, data, err := DecodeProviderDataURL(reference.DataURL)
		return data, mimeType, err
	}
	value := strings.TrimSpace(reference.URL)
	if value == "" {
		return nil, "", errors.New("声明式协议媒体结果地址为空")
	}
	data, mimeType, err := GetProviderExternalBinary(WithRequestKind(ctx, "download"), config, value)
	return data, NormalizedMediaMIMEType(mimeType, data), err
}

func RetryableProtocolMediaDownload(err error) bool {
	if err == nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}
	if outbound.IsConnectionInterrupted(err) {
		return true
	}
	var networkError net.Error
	if errors.As(err, &networkError) && (networkError.Timeout() || networkError.Temporary()) {
		return true
	}
	message := strings.ToLower(err.Error())
	for _, marker := range []string{"tls handshake timeout", "connection reset", "unexpected eof", "broken pipe"} {
		if strings.Contains(message, marker) {
			return true
		}
	}
	return false
}

func ProtocolResultError(message, taskID string, bodies ...[]byte) error {
	// Keep structured failure codes instead of flattening them to plugin prose.
	if len(bodies) > 0 {
		var payload map[string]interface{}
		if json.Unmarshal(bodies[0], &payload) == nil {
			requestID := firstNonEmpty(stringField(payload, "request_id"), stringField(payload, "requestId"))
			if nested, ok := payload["data"].(map[string]interface{}); ok {
				payload = nested
			}
			if errPayload, ok := payload["error"].(map[string]interface{}); ok && stringField(errPayload, "code") != "" {
				requestID = firstNonEmpty(stringField(errPayload, "request_id"), stringField(errPayload, "requestId"), stringField(payload, "request_id"), requestID)
				raw, _ := json.Marshal(map[string]interface{}{"task_id": taskID, "request_id": requestID, "error": map[string]string{"code": stringField(errPayload, "code"), "message": stringField(errPayload, "message"), "type": stringField(errPayload, "type"), "param": stringField(errPayload, "param")}})
				return NewRawPayloadError(string(raw))
			}
		}
	}
	message = strings.TrimSpace(message)
	if message == "" {
		message = "上游返回失败状态"
	}
	if taskID == "" {
		return errors.New(message)
	}
	return fmt.Errorf("声明式协议任务失败（任务 %s）：%s", taskID, message)
}

func ValidateGenerationInterface(mode string, interfaceType string) error {
	// Standalone callers (including legacy tests and migration tools) may not
	// have a Service/plugin runtime. Use the shipped declarative catalog first;
	// fall back to host builtins only when the package catalog is unavailable.
	registry := LoadOfficialFallbackRegistry()
	if registry == nil {
		registry = protocol.Builtins()
	} else if _, ok := registry.Resolve(strings.TrimSpace(interfaceType)); !ok {
		// A deployment may ship only a subset of the optional plugin catalog.
		// Preserve the host-backed builtins for standalone validation instead of
		// reporting a false "not installed" error for those interfaces.
		if _, builtinOK := protocol.Builtins().Resolve(strings.TrimSpace(interfaceType)); builtinOK {
			registry = protocol.Builtins()
		}
	}
	return ValidateGenerationInterfaceWithRegistry(registry, mode, interfaceType)
}

func ValidateGenerationInterfaceWithRegistry(registry *protocol.Registry, mode string, interfaceType string) error {
	interfaceType = strings.TrimSpace(interfaceType)
	if interfaceType == "" {
		return nil
	}
	adapter, ok := registry.Resolve(interfaceType)
	if !ok {
		return fmt.Errorf("接口类型 %s 未安装", interfaceType)
	}
	metadata := adapter.Metadata()
	if !metadata.Enabled || metadata.UnavailableReason != "" {
		return fmt.Errorf("接口类型 %s 当前不可用：%s", interfaceType, metadata.UnavailableReason)
	}
	if mode != "" && !ProtocolCapabilityMatches(metadata, protocol.Capability(mode)) {
		return fmt.Errorf("接口类型 %s 不支持%s生成", interfaceType, mode)
	}
	return nil
}

func ProtocolCapabilityMatches(metadata protocol.Metadata, capability protocol.Capability) bool {
	for _, item := range metadata.Categories {
		if item == capability {
			return true
		}
	}
	return false
}
