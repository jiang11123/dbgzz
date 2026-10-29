package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/app"

	"github.com/gin-gonic/gin"
)

type failureEnvelope struct {
	Code   int    `json:"code"`
	Msg    string `json:"msg"`
	Reason string `json:"reason"`
}

func TestFailServiceProjectsAppError(t *testing.T) {
	recorder, context := responseTestContext()
	err := app.RateLimited("请求过于频繁，请稍后重试")

	failService(context, err)

	response := decodeFailureEnvelope(t, recorder)
	if recorder.Code != http.StatusTooManyRequests || response.Code != app.CodeRateLimited || response.Reason != string(app.ReasonRateLimited) || response.Msg != err.Message {
		t.Fatalf("response = status %d, body %#v", recorder.Code, response)
	}
}

func TestFailServicePreservesPublicReferenceRequirements(t *testing.T) {
	recorder, context := responseTestContext()
	failService(context, &app.AppError{Status: 400, Code: 400, Reason: "reference_media_requires_url", Message: "参考音频需要链接", Details: map[string]any{"requiredReferences": []map[string]any{{"kind": "audio", "index": 0}}}})
	var envelope struct {
		Details struct {
			RequiredReferences []struct {
				Kind  string
				Index int
			} `json:"requiredReferences"`
		} `json:"details"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if len(envelope.Details.RequiredReferences) != 1 || envelope.Details.RequiredReferences[0].Kind != "audio" {
		t.Fatal(recorder.Body.String())
	}
}

func TestFailServiceQuotaExceeded(t *testing.T) {
	recorder, context := responseTestContext()
	failService(context, app.QuotaExceeded("账号素材数量已达到 100 个上限"))

	response := decodeFailureEnvelope(t, recorder)
	if recorder.Code != http.StatusForbidden || response.Code != app.CodeQuotaExceeded || response.Reason != string(app.ReasonQuotaExceeded) {
		t.Fatalf("quota response = status %d, body %#v", recorder.Code, response)
	}
}

func TestFailServiceHidesUnclassifiedInternalError(t *testing.T) {
	recorder, context := responseTestContext()
	failService(context, errors.New("database password=secret"))

	response := decodeFailureEnvelope(t, recorder)
	if recorder.Code != http.StatusInternalServerError || response.Code != http.StatusInternalServerError {
		t.Fatalf("response = status %d, body %#v", recorder.Code, response)
	}
	if response.Msg != internalErrorMessage || strings.Contains(recorder.Body.String(), "password=secret") {
		t.Fatalf("internal error leaked in response: %s", recorder.Body.String())
	}
}

func TestFailInternalKeepsStatusWithoutLeakingCause(t *testing.T) {
	recorder, context := responseTestContext()
	failInternal(context, http.StatusServiceUnavailable, errors.New("redis://user:password@private-host"))

	response := decodeFailureEnvelope(t, recorder)
	if recorder.Code != http.StatusServiceUnavailable || response.Msg != "服务暂时不可用，请稍后重试" {
		t.Fatalf("response = status %d, body %#v", recorder.Code, response)
	}
	if strings.Contains(recorder.Body.String(), "private-host") {
		t.Fatalf("internal cause leaked in response: %s", recorder.Body.String())
	}
}

func TestParsePaginationQueryUsesDefaultsAndRejectsInvalidValues(t *testing.T) {
	gin.SetMode(gin.TestMode)
	tests := []struct {
		name      string
		query     string
		page      int
		pageSize  int
		wantError bool
	}{
		{name: "defaults", query: "", page: 1, pageSize: 40},
		{name: "explicit values", query: "page=3&pageSize=25", page: 3, pageSize: 25},
		{name: "invalid page", query: "page=abc", wantError: true},
		{name: "zero page", query: "page=0", wantError: true},
		{name: "negative page size", query: "pageSize=-1", wantError: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "/api/test?"+tt.query, nil)
			context, _ := gin.CreateTestContext(httptest.NewRecorder())
			context.Request = request
			page, pageSize, err := parsePaginationQuery(context, 40)
			if (err != nil) != tt.wantError {
				t.Fatalf("error = %v, wantError = %t", err, tt.wantError)
			}
			if tt.wantError {
				return
			}
			if page != tt.page || pageSize != tt.pageSize {
				t.Fatalf("pagination = (%d, %d), want (%d, %d)", page, pageSize, tt.page, tt.pageSize)
			}
		})
	}
}

func responseTestContext() (*httptest.ResponseRecorder, *gin.Context) {
	recorder := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(recorder)
	context.Request = httptest.NewRequest(http.MethodGet, "/api/test", nil)
	return recorder, context
}

func decodeFailureEnvelope(t *testing.T, recorder *httptest.ResponseRecorder) failureEnvelope {
	t.Helper()
	var response failureEnvelope
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	return response
}
