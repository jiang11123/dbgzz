package generation

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/jpeg"
	"mime/multipart"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"infinite-canvas/backend/internal/beefapi"
	"infinite-canvas/backend/internal/modelcatalog"
	"infinite-canvas/backend/internal/providerpreset"
)

type auditLiveReceipts struct {
	mu           sync.Mutex
	requests     []string
	providerTask string
}

func (p *auditLiveReceipts) Observe(o TransportObservation) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if o.RequestID != "" {
		p.requests = append(p.requests, o.RequestID)
	}
	if o.Request.Method == "POST" && strings.Contains(o.Request.URL.Path, "videos") {
		if id, err := ExtractProviderTaskID(o.Body); err == nil && id != "" {
			p.providerTask = id
		}
	}
}
func (*auditLiveReceipts) NotifyPoll(context.Context, string, error) {}
func (*auditLiveReceipts) SyncProgress(string, []byte)               {}

// Exactly one image create is admitted. A lost response stays unknown; the
// live harness never retries creates, changes keys or resubmits a user's task.
type auditSingleImageSend struct {
	key  string
	sent bool
}

func (p *auditSingleImageSend) Intercept(req *http.Request) (bool, []byte, string, error) {
	if !RecoverableImageEndpoint(req) {
		return false, nil, "", nil
	}
	if p.sent {
		return true, nil, "", fmt.Errorf("live audit refused another image create")
	}
	p.sent = true
	req.Header.Set("Idempotency-Key", p.key)
	data, mime, err := DoBinaryWithConsumer(req, nil)
	return true, data, mime, err
}

type auditLiveResult struct {
	Model         string   `json:"model"`
	Mode          string   `json:"mode"`
	Protocol      string   `json:"protocol"`
	Status        string   `json:"status"`
	Category      string   `json:"category,omitempty"`
	Message       string   `json:"message,omitempty"`
	Bytes         int      `json:"bytes,omitempty"`
	Width         int      `json:"width,omitempty"`
	Height        int      `json:"height,omitempty"`
	Requests      []string `json:"requestIds,omitempty"`
	ProviderTask  string   `json:"providerTaskId,omitempty"`
	Seconds       float64  `json:"elapsedSeconds"`
	SpentCNY      float64  `json:"auditSpentCNY"`
	SubmissionKey string   `json:"submissionKey,omitempty"`
	Uncertain     bool     `json:"uncertain,omitempty"`
	ReservedCNY   float64  `json:"reservedCNY,omitempty"`
	Detail        string   `json:"detail,omitempty"`
	HTTPStatus    int      `json:"httpStatus,omitempty"`
	ProviderCode  string   `json:"providerCode,omitempty"`
}

// Explicit opt-in only: reads an existing managed credential, exercises the
// production generation adapters and checks the live ledger before each call.
// No account, credential, channel, workspace or production state is modified.
func TestBeefAPIModelAdapterLiveMatrix(t *testing.T) {
	if os.Getenv("BEEFTV_MODEL_AUDIT_LIVE") != "1" {
		t.Skip("explicit paid model audit opt-in required")
	}
	dir := os.Getenv("BEEFTV_AUDIT_OUT")
	if dir == "" {
		t.Fatal("audit output directory required")
	}
	limit, err := strconv.ParseFloat(os.Getenv("BEEFTV_AUDIT_MAX_CNY"), 64)
	if err != nil || limit <= 0 || limit > 50 {
		t.Fatal("explicit positive budget at most 50 CNY required")
	}
	executorPath := os.Getenv("BEEFTV_AUDIT_EXEC")
	if executorPath == "" {
		t.Fatal("explicit read-only billing executor required")
	}
	credentialDir := os.Getenv("BEEFTV_AUDIT_CREDENTIAL_DIR")
	if info, err := os.Stat(credentialDir); err != nil || !info.IsDir() {
		t.Fatal("explicit existing credential directory required")
	}
	svc, err := beefapi.New(beefapi.Options{DataDir: credentialDir})
	if err != nil {
		t.Fatal("managed connection could not be opened")
	}
	defer svc.Close()
	credential, err := svc.Resolve()
	if err != nil || !regexp.MustCompile(`^[0-9]+$`).MatchString(credential.TokenID) {
		t.Fatal("managed credential unavailable")
	}
	raw, err := os.ReadFile(filepath.Join(dir, "catalog.json"))
	if err != nil {
		t.Fatal(err)
	}
	var catalog struct {
		Data []struct {
			ID        string          `json:"id"`
			Endpoints []string        `json:"supported_endpoint_types"`
			Video     json.RawMessage `json:"video_capabilities"`
		} `json:"data"`
	}
	if json.Unmarshal(raw, &catalog) != nil {
		t.Fatal("invalid audit catalog")
	}
	file, err := os.OpenFile(filepath.Join(dir, "live-results.jsonl"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	start := time.Now().Unix()
	startPath := filepath.Join(dir, "live-start.txt")
	if old, err := os.ReadFile(startPath); err == nil {
		if parsed, err := strconv.ParseInt(strings.TrimSpace(string(old)), 10, 64); err == nil {
			start = parsed
		} else {
			t.Fatal("invalid audit start")
		}
	} else if err := os.WriteFile(startPath, []byte(strconv.FormatInt(start, 10)), 0600); err != nil {
		t.Fatal(err)
	}
	ledger := func() (float64, error) {
		command := fmt.Sprintf("docker exec beefapi-postgres psql -U beefapi -d beefapi -At -c \"SELECT coalesce(sum(quota),0) FROM logs WHERE token_id=%s AND created_at>=%d AND type=2 AND quota>0;\"", credential.TokenID, start)
		out, err := exec.Command(executorPath, command).Output()
		if err != nil {
			return 0, fmt.Errorf("billing ledger unavailable")
		}
		quota, err := strconv.ParseFloat(strings.TrimSpace(string(out)), 64)
		return quota / 500000, err
	}
	if _, err := ledger(); err != nil {
		t.Fatal(err)
	}
	var gate sync.Mutex
	reserved := 0.0
	seen := map[string]bool{}
	previous, _ := os.ReadFile(filepath.Join(dir, "live-results.jsonl"))
	last := map[string]auditLiveResult{}
	for _, line := range bytes.Split(previous, []byte("\n")) {
		var old auditLiveResult
		if json.Unmarshal(line, &old) == nil {
			seen[old.Model] = true
			last[old.Model] = old
		}
	}
	for _, old := range last {
		if strings.Contains(","+os.Getenv("BEEFTV_AUDIT_RETRY_UNSENT")+",", ","+old.Model+",") && strings.Contains(old.Detail, "读取 multipart 文件") {
			continue
		}
		if old.Status == "started" || old.Uncertain {
			reserved += old.ReservedCNY
		}
	}
	frame := h3SyntheticFrame(t, false)
	var resumeMap map[string]string
	_ = json.Unmarshal([]byte(os.Getenv("BEEFTV_AUDIT_RESUME_MAP")), &resumeMap)
	for name, id := range resumeMap {
		old := last[name]
		old.ProviderTask = id
		last[name] = old
	}
	registry := LoadOfficialFallbackRegistry()
	if _, ok := registry.Resolve("openai-image"); !ok {
		t.Fatal("official packages must be built before paid calls")
	}
	sort.Slice(catalog.Data, func(i, j int) bool { return catalog.Data[i].ID < catalog.Data[j].ID })
	workers := make(chan struct{}, 3)
	var wg sync.WaitGroup
	for _, item := range catalog.Data {
		recheckResponse := last[item.ID].Status == "succeeded" && last[item.ID].Protocol != "openai-response" && strings.Contains(strings.Join(item.Endpoints, ","), "openai-response")
		recheckComplete := !last[item.ID].Uncertain && last[item.ID].Detail == "声明式协议已完成但没有返回结果" && strings.Contains(","+os.Getenv("BEEFTV_AUDIT_RECHECK_COMPLETE")+",", ","+item.ID+",")
		speechCheck := os.Getenv("BEEFTV_AUDIT_SPEECH_FILE") != "" && last[item.ID].Status == "succeeded" && last[item.ID].Bytes == 0 && strings.Contains(strings.Join(item.Endpoints, ","), "audio.transcriptions")
		recoverCached := strings.Contains(","+os.Getenv("BEEFTV_AUDIT_RECOVER_CACHED")+",", ","+item.ID+",")
		resumeVideo := last[item.ID].ProviderTask != "" && strings.Contains(","+os.Getenv("BEEFTV_AUDIT_RESUME_VIDEO")+",", ","+item.ID+",")
		retryUnsent := strings.Contains(","+os.Getenv("BEEFTV_AUDIT_RETRY_UNSENT")+",", ","+item.ID+",")
		if (seen[item.ID] && !recoverCached && !resumeVideo && !retryUnsent && !speechCheck && !recheckResponse && !recheckComplete) || (os.Getenv("BEEFTV_AUDIT_ONLY") != "" && !strings.Contains(","+os.Getenv("BEEFTV_AUDIT_ONLY")+",", ","+item.ID+",")) {
			continue
		}
		wg.Add(1)
		workers <- struct{}{}
		go func(id string, endpoints []string, videoRaw json.RawMessage) {
			defer wg.Done()
			defer func() { <-workers }()
			mode, protocol := "text", "chat-completion"
			hasResponse := false
			for _, endpoint := range endpoints {
				switch endpoint {
				case "openai-response", "openai-response-compact", "responses":
					hasResponse = true
				case "anthropic":
					protocol = "claude-api"
				case "image-generation":
					mode, protocol = "image", "openai-image"
				case "audio.speech":
					mode, protocol = "audio", "openai-audio"
				case "audio.transcriptions":
					mode, protocol = "transcription", "openai-audio"
				}
			}
			if mode == "text" && hasResponse {
				protocol = "openai-response"
			}
			if _, ok := providerpreset.BeefAPIImageContract(id); ok {
				mode, protocol = "image", "openai-image"
			}
			if contract, ok := providerpreset.BeefAPIVideoContract(id); ok {
				mode, protocol = "video", contract.Protocol
			}
			if id == "grok-imagine-video-1.5" || id == "kling-video-v3" {
				mode, protocol = "video", "newapi"
			}
			reserve := 0.1
			if mode == "image" {
				reserve = 0.6
			}
			if mode == "audio" {
				reserve = 1.1
			}
			if mode == "video" {
				reserve = 8
			}
			gate.Lock()
			spent, billErr := ledger()
			if billErr != nil || spent+reserved+reserve > limit {
				gate.Unlock()
				t.Logf("budget/preflight stop: %s", id)
				return
			}
			reserved += reserve
			key := fmt.Sprintf("model-audit-%d-%s", start, id)
			if speechCheck {
				key += "-speech"
			}
			if recheckResponse {
				key += "-response-protocol"
			}
			if recheckComplete {
				key += "-confirmed-parser-recheck"
			}
			if recoverCached {
				if old, ok := last[id]; ok && old.SubmissionKey != "" {
					key = old.SubmissionKey
				} else {
					gate.Unlock()
					t.Errorf("cached identity unavailable")
					return
				}
			}
			if err := json.NewEncoder(file).Encode(auditLiveResult{Model: id, Mode: mode, Protocol: protocol, Status: "started", SubmissionKey: key, ReservedCNY: reserve}); err != nil {
				reserved -= reserve
				gate.Unlock()
				t.Errorf("could not persist audit identity")
				return
			}
			if err := file.Sync(); err != nil {
				reserved -= reserve
				gate.Unlock()
				t.Errorf("could not sync audit identity")
				return
			}
			gate.Unlock()
			began := time.Now()
			record := auditLiveResult{Model: id, Mode: mode, Protocol: protocol, Status: "failed", SubmissionKey: key}
			receipts := &auditLiveReceipts{}
			runtime := taskRuntime(func(r *Runtime) { r.Images = &auditSingleImageSend{key: key}; r.Receipts = receipts; r.Call.Model = id })
			ctx, cancel := context.WithTimeout(WithSubmissionKey(WithProtocolRegistry(WithRuntime(context.Background(), runtime), registry), key), 8*time.Minute)
			if resumeVideo {
				ctx = EnrichCallMeta(ctx, CallMeta{ProviderRequestID: last[id].ProviderTask})
				receipts.providerTask = last[id].ProviderTask
			}
			defer cancel()
			input := Input{Mode: mode, Prompt: "Reply with OK only.", MaxOutputTokens: 128, Config: Config{BaseURL: credential.BaseURL, APIKey: credential.APIKey, Model: id, InterfaceType: protocol, Size: "1:1", Count: "1", Quality: "auto", VideoSeconds: "4", VQuality: "480", AudioFormat: "mp3", VideoGenerateAudio: "false"}}
			if mode == "image" {
				input.Prompt = "A small red paper ball on a pale teal table, no text."
				input.ReferenceImages = []Media{{DataURL: frame}}
			}
			if mode == "video" {
				input.Prompt = "A small red ball moves slowly on a pale teal table, fixed camera."
				input.Config.Size = "16:9"
				if id == "kling-video-v3" || id == "grok-imagine-video-1.5" {
					input.Config.VQuality = "720"
					if id == "kling-video-v3" {
						input.Config.VideoSeconds = "5"
					}
				}
				if id == "minimax-h3-max-turbo" {
					input.Config.VideoSeconds = "1"
				}
				input.ReferenceImages = []Media{{DataURL: frame, Width: 768, Height: 512}}
				if v, ok := beefapi.NormalizeCatalogVideoCapability(videoRaw); ok {
					raw, _ := json.Marshal(v)
					var profile modelcatalog.VideoCapabilityConfig
					_ = json.Unmarshal(raw, &profile)
					input.VideoCapability = &profile
				}
			}
			if mode == "audio" {
				input.Prompt = "你好，这是模型接口测试。"
				if strings.Contains(id, "music") {
					input.Prompt = "轻柔的钢琴纯音乐，温暖明亮，不要人声。"
				}
			}
			var result map[string]interface{}
			var runErr error
			if mode == "transcription" {
				media := Media{DataURL: h3SyntheticAudio(), Name: "audit.wav"}
				if path := os.Getenv("BEEFTV_AUDIT_SPEECH_FILE"); path != "" {
					data, err := os.ReadFile(path)
					if err != nil {
						t.Error("speech fixture unavailable")
						return
					}
					media = Media{DataURL: DataURL("audio/mpeg", data), Name: "audit.mp3"}
				}
				var body bytes.Buffer
				writer := multipart.NewWriter(&body)
				_ = writer.WriteField("model", id)
				_ = writeMediaPart(writer, "file", media)
				_ = writer.Close()
				var response map[string]interface{}
				runErr = PostForm(ctx, input.Config, "/audio/transcriptions", writer.FormDataContentType(), &body, &response)
				if runErr == nil {
					result = map[string]interface{}{"text": stringField(response, "text")}
				}
			} else {
				result, runErr = Execute(ctx, input)
			}
			if runErr == nil {
				record.Status = "succeeded"
				if mode == "text" || mode == "transcription" {
					record.Bytes = len(stringField(result, "text"))
					if mode == "transcription" {
						record.Detail = sanitizeProviderText(stringField(result, "text"))
					}
					if (mode == "text" || os.Getenv("BEEFTV_AUDIT_SPEECH_FILE") != "") && record.Bytes == 0 {
						record.Status = "empty_result"
					}
				} else {
					var value string
					if mode == "image" {
						switch images := result["images"].(type) {
						case []map[string]string:
							if len(images) > 0 {
								value = images[0]["dataUrl"]
							}
						case []interface{}:
							if len(images) > 0 {
								value = stringField(images[0].(map[string]interface{}), "dataUrl")
							}
						}
					} else {
						value = stringField(result[mode].(map[string]interface{}), "dataUrl")
					}
					var data []byte
					var mime string
					if strings.HasPrefix(value, "data:") {
						mime, data, runErr = DecodeProviderDataURL(value)
					} else {
						data, mime, runErr = GetProviderExternalBinary(WithRequestKind(ctx, "download"), input.Config, value)
					}
					if runErr == nil {
						record.Bytes = len(data)
						if record.Bytes == 0 {
							record.Status = "empty_result"
						}
						if mode == "image" {
							size, _, err := image.DecodeConfig(bytes.NewReader(data))
							if err != nil {
								runErr = fmt.Errorf("generated image cannot decode")
							} else {
								record.Width, record.Height = size.Width, size.Height
							}
						}
						ext := map[string]string{"image": "png", "video": "mp4", "audio": "mp3"}[mode]
						_ = mime
						runErr = os.WriteFile(filepath.Join(dir, id+"."+ext), data, 0600)
					}
				}
			}
			if runErr != nil {
				failure := ClassifyError(runErr)
				record.Status = "failed"
				record.Category = string(failure.Category)
				record.Message = failure.UserMessage()
				record.Detail = sanitizeProviderText(runErr.Error())
				var httpError HTTPError
				if errors.As(runErr, &httpError) {
					decoded := ClassifyHTTP(httpError.StatusCode, httpError.Status, httpError.Body)
					record.Detail = decoded.ProviderMessage
					record.HTTPStatus = httpError.StatusCode
					record.ProviderCode = decoded.ProviderCode
				}
				record.Uncertain = failure.Uncertain
			}
			record.Requests, record.ProviderTask = receipts.requests, receipts.providerTask
			record.Seconds = time.Since(began).Seconds()
			gate.Lock()
			if record.Uncertain {
				record.ReservedCNY = reserve
			} else {
				reserved -= reserve
			}
			record.SpentCNY, _ = ledger()
			_ = json.NewEncoder(file).Encode(record)
			gate.Unlock()
			t.Logf("%s %s: %s bytes=%d spent=%.4f", mode, id, record.Status, record.Bytes, record.SpentCNY)
			if record.Status != "succeeded" {
				t.Errorf("model %s: %s (%s)", id, record.Status, record.Category)
			}
		}(item.ID, item.Endpoints, item.Video)
	}
	wg.Wait()
	spent, err := ledger()
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("live audit charged %.6f CNY (limit %.2f)", spent, limit)
	if spent > limit {
		t.Fatal("budget exceeded")
	}
}
