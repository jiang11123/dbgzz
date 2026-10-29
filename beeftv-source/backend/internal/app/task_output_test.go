package app

import (
	"encoding/json"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestTaskForOutputRedactsRoutingAndSecrets(t *testing.T) {
	task := model.Task{
		InputJSON:              `{"mode":"image","metadata":{"source":"create-page"},"config":{"apiKey":"secret"},"resourceId":"resource-1"}`,
		LogicalModelRevisionID: "revision-1",
		RouteID:                "route-1",
		ChannelModelID:         "channel-model-1",
	}

	output := taskForOutput(task)
	if output.LogicalModelRevisionID != "" || output.RouteID != "" || output.ChannelModelID != "" {
		t.Fatalf("internal routing fields leaked: %+v", output)
	}
	var input map[string]any
	if err := json.Unmarshal([]byte(output.InputJSON), &input); err != nil {
		t.Fatalf("public input is not valid JSON: %v", err)
	}
	if _, exists := input["config"]; exists {
		t.Fatal("provider config must not be exposed")
	}
	if input["resourceId"] != "resource-1" {
		t.Fatalf("resource identity was not preserved: %#v", input)
	}
}

func TestTaskMediaPreviewUsesSafeMediaURLs(t *testing.T) {
	previewURL, previewKind := taskMediaPreview(`{"images":["data:image/png;base64,AAAA","/api/resources/resource-1/file"],"video":"https://cdn.example.com/output.mp4"}`, "video")
	if previewURL != "/api/resources/resource-1/file" || previewKind != "image" {
		t.Fatalf("unexpected preview: url=%q kind=%q", previewURL, previewKind)
	}
	if previewURL, _ := taskMediaPreview(`{"url":"file:///tmp/output.mp4"}`, "video"); previewURL != "" {
		t.Fatalf("unsafe local URL was exposed: %q", previewURL)
	}
}

func TestTaskMediaPreviewSeparatesVideoPoster(t *testing.T) {
	previewURL, previewKind, posterURL := taskMediaPreviewWithPoster(`{"video":{"url":"https://cdn.example.com/output.mp4","posterUrl":"https://cdn.example.com/poster.webp"}}`, "canvas_video")
	if previewURL != "https://cdn.example.com/output.mp4" || previewKind != "video" || posterURL != "https://cdn.example.com/poster.webp" {
		t.Fatalf("unexpected video preview: url=%q kind=%q poster=%q", previewURL, previewKind, posterURL)
	}
	if _, _, posterURL := taskMediaPreviewWithPoster(`{"video":{"url":"https://cdn.example.com/output.mp4","posterUrl":"file:///tmp/poster.png"}}`, "canvas_video"); posterURL != "" {
		t.Fatalf("unsafe local poster was exposed: %q", posterURL)
	}
}

func TestTaskClientContextRequiresCreatePageMetadata(t *testing.T) {
	valid := taskClientContext(`{"metadata":{"source":"create-page","conversationId":"conversation-1","messageId":"message-1","batchIndex":2,"batchCount":4}}`)
	if valid == nil || valid.ConversationID != "conversation-1" || valid.BatchIndex != 2 {
		t.Fatalf("valid client context was not decoded: %+v", valid)
	}
	if context := taskClientContext(`{"metadata":{"source":"other","conversationId":"conversation-1","messageId":"message-1"}}`); context != nil {
		t.Fatalf("unexpected context for non-create-page task: %+v", context)
	}
}

func TestTaskSummaryExposesStablePaymentRequiredCode(t *testing.T) {
	summary := taskSummaryForOutput(model.Task{Error: "上游模型服务返回 HTTP 402：当前账户余额不足"})
	if summary.ErrorCode != "quota_unknown" {
		t.Fatalf("ErrorCode = %q, want quota_unknown", summary.ErrorCode)
	}
}

func TestTaskClientContextPreservesCanvasNodeID(t *testing.T) {
	context := taskClientContext(`{"mode":"image","metadata":{"nodeId":"canvas-node-1","source":"canvas"}}`)
	if context == nil || context.NodeID != "canvas-node-1" {
		t.Fatalf("canvas node context was not preserved: %+v", context)
	}
}

func TestTaskSummaryExposesDirectorPanoramaRecoveryIdentityOnly(t *testing.T) {
	summary := taskSummaryForOutput(model.Task{
		ID: "task-1", ProjectID: "project-1", Type: "canvas_image",
		InputJSON: `{"metadata":{"source":"director-panorama","sceneId":"scene-1","providerOptions":{"secret":"hidden"}},"config":{"apiKey":"private-test-value"}}`,
	})
	if summary.ClientContext == nil || summary.ClientContext.Source != "director-panorama" || summary.ClientContext.SceneID != "scene-1" {
		t.Fatalf("director panorama recovery identity missing: %+v", summary.ClientContext)
	}
	encoded, err := json.Marshal(summary)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"private-test-value", "hidden", "providerOptions", "inputJson"} {
		if strings.Contains(string(encoded), secret) {
			t.Fatalf("summary leaked %s: %s", secret, encoded)
		}
	}
}

func TestTaskSummaryProjectsClassifiedErrorWithoutRawBody(t *testing.T) {
	summary := taskSummaryForOutput(model.Task{
		ID:    "task-1",
		Type:  "canvas_image",
		Error: (providerHTTPError{StatusCode: 451, Body: "Your prompt or reference image was blocked by the content safety policy."}).Error(),
	})
	if summary.ErrorCode != "moderation_input" && summary.ErrorCode != "moderation_reference" {
		t.Fatalf("errorCode = %q error=%q", summary.ErrorCode, summary.Error)
	}
	if !strings.Contains(summary.Error, "内容安全审核") {
		t.Fatalf("summary error = %q", summary.Error)
	}
	if strings.Contains(summary.Error, "content safety policy") {
		t.Fatalf("raw safety body leaked: %q", summary.Error)
	}
}

func TestTaskSummaryPreservesCanvasNodeWithoutExposingInput(t *testing.T) {
	summary := taskSummaryForOutput(model.Task{
		ID: "task-1", ProjectID: "project-1", Type: "canvas_image",
		InputJSON: `{"metadata":{"nodeId":"node-1"},"config":{"apiKey":"private-test-value"}}`,
	})
	encoded, err := json.Marshal(summary)
	if err != nil {
		t.Fatal(err)
	}
	var output map[string]any
	if err := json.Unmarshal(encoded, &output); err != nil {
		t.Fatal(err)
	}
	context, ok := output["clientContext"].(map[string]any)
	if !ok || context["nodeId"] != "node-1" || len(context) != 1 {
		t.Fatalf("summary lost safe canvas association: %#v", output)
	}
	for _, key := range []string{"inputJson", "config", "apiKey"} {
		if _, exists := output[key]; exists {
			t.Fatalf("summary leaked %s", key)
		}
	}
}

func TestTaskClientContextProjectsChapterOperations(t *testing.T) {
	characters := taskClientContext(`{"metadata":{"domainProjectId":"project-1","chapterId":"chapter-1","operation":"chapter_character_breakdown"}}`)
	if characters == nil || characters.DomainProjectID != "project-1" || characters.ChapterID != "chapter-1" || characters.ChapterOperation != "characters" {
		t.Fatalf("character task context was not decoded: %+v", characters)
	}
	storyboard := taskClientContext(`{"metadata":{"source":"short-drama-chapter-storyboard","domainProjectId":"project-1","chapterId":"chapter-2"}}`)
	if storyboard == nil || storyboard.ChapterID != "chapter-2" || storyboard.ChapterOperation != "storyboard" {
		t.Fatalf("storyboard task context was not decoded: %+v", storyboard)
	}
	if context := taskClientContext(`{"metadata":{"domainProjectId":"project-1","chapterId":"chapter-1","operation":"unrelated"}}`); context != nil {
		t.Fatalf("unexpected context for unrelated project task: %+v", context)
	}
}

func TestTaskClientContextProjectsShotWorkflow(t *testing.T) {
	context := taskClientContext(`{"metadata":{"domainProjectId":"project-1","shotId":"shot-1","workflowStepId":"step-1","artifactType":"video"}}`)
	if context == nil || context.DomainProjectID != "project-1" || context.ShotID != "shot-1" || context.WorkflowStepID != "step-1" || context.ArtifactType != "video" {
		t.Fatalf("shot task context was not decoded: %+v", context)
	}
}

func TestTaskOutputResourceReadsPersistedMedia(t *testing.T) {
	id, mediaType := taskOutputResource(`{"mode":"video","video":{"resourceId":"resource-1","storageKey":"resource:resource-1"}}`, "canvas_video")
	if id != "resource-1" || mediaType != "video" {
		t.Fatalf("unexpected task output resource: id=%q mediaType=%q", id, mediaType)
	}
}

func TestHistoricalVODParameterFailureProjection(t *testing.T) {
	original := model.Task{Type: "canvas_image", Status: model.TaskStatusFailed, Stage: "submission_unknown", Error: "图片结果尚未确认", FailureDiagnostics: &model.TaskFailureDiagnostics{ProviderCode: "vod_image_invalid_params", HTTPStatus: 400, Requests: []model.TaskRequestEvidence{{Dispatched: true, Outcome: "http_error", HTTPStatus: 400, ProviderCode: "vod_image_invalid_params"}}}}
	got := taskForOutput(original)
	if got.ErrorCode != "invalid_params" || got.Stage == "submission_unknown" {
		t.Fatalf("not corrected: %+v", got)
	}
	if taskSummaryForOutput(original).ErrorCode != "invalid_params" {
		t.Fatal("list differs from detail")
	}
	if original.Stage != "submission_unknown" || original.FailureDiagnostics.Summary != "" {
		t.Fatal("history mutated")
	}
	original.FailureDiagnostics.Requests = append(original.FailureDiagnostics.Requests, model.TaskRequestEvidence{Outcome: "transport_error"})
	if taskForOutput(original).Stage != "submission_unknown" {
		t.Fatal("earlier unknown submission discarded")
	}
}
