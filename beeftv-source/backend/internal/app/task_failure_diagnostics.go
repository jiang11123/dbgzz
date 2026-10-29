package app

import (
	"errors"
	"runtime"
	"time"

	"infinite-canvas/backend/internal/buildinfo"
	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/outbound"
)

func captureTaskFailureDiagnostics(task *model.Task, err error, source string) {
	if err == nil {
		return
	}
	failure := classifyTaskFailure(err)
	d := &model.TaskFailureDiagnostics{Source: source, Summary: firstNonEmpty(failure.ProviderMessage, err.Error()),
		RequestID: failure.RequestID, ProviderTaskID: failure.TaskID, Param: failure.Param,
		Stage: task.Stage, CapturedAt: time.Now().Format(time.RFC3339Nano)}
	d.Version, d.Platform = buildinfo.Current().Version, runtime.GOOS+"/"+runtime.GOARCH
	if prior := task.FailureDiagnostics; prior != nil {
		d.Requests, d.OmittedRequests, d.Input, d.ExecutionResult = prior.Requests, prior.OmittedRequests, prior.Input, prior.ExecutionResult
	}
	if source == "local_result" {
		d.Stage = "本地结果处理"
		if failure.Category == generation.CategoryLocalDiskFull {
			d.Stage = "保存生成结果（磁盘空间不足）"
		}
	}
	if len(d.Requests) > 0 && d.Requests[len(d.Requests)-1].Outcome == "response_limit" {
		last := d.Requests[len(d.Requests)-1]
		d.Source, d.Stage, d.RequestID, d.HTTPStatus = "local_response", "本地响应大小校验", last.RequestID, last.HTTPStatus
	}
	var httpErr providerHTTPError
	var payload providerPayloadError
	var appErr *kernel.AppError
	var upload *generation.ReferenceUploadError
	var dns *outbound.DNSResolutionError
	var download videoDownloadError
	switch {
	case errors.As(err, &upload):
		d.Source, d.Stage, d.Summary = "reference_upload", upload.Meta.Label(), upload.Error()
		d.FailedOperation, d.TransportPhase = "reference_"+upload.Meta.Stage, upload.TransportPhase
		d.HTTPStatus, d.ProviderCode, d.RequestID = upload.HTTPStatus, upload.Code, upload.RequestID
	case errors.As(err, &dns):
		d.Source, d.TransportPhase = "local_network", "dns"
		d.Stage = "解析模型服务域名"
		if errors.As(err, &download) || task.Stage == "正在取回生成结果" {
			d.Stage = "取回生成结果（DNS 解析）"
		} else if task.ProviderRequestID != "" {
			d.Stage = "查询原任务（DNS 解析）"
		}
	case errors.As(err, &httpErr):
		d.Source, d.HTTPStatus, d.ProviderCode = "upstream_http", httpErr.StatusCode, failure.ProviderCode
		d.RequestID = firstNonEmpty(failure.RequestID, httpErr.RequestID)
	case errors.As(err, &payload):
		d.Source, d.ProviderCode = "upstream_response", failure.ProviderCode
		if failure.Category == generation.CategoryInputInaccessible {
			d.Stage = "上游读取参考素材"
		} else if task.ProviderRequestID != "" {
			d.Stage = "上游任务处理"
		}
		if len(d.Requests) > 0 {
			last := d.Requests[len(d.Requests)-1]
			d.RequestID, d.HTTPStatus = firstNonEmpty(d.RequestID, last.RequestID), last.HTTPStatus
		}
	case errors.As(err, &appErr) && appErr.Status == 400 && source != "local_result":
		d.Source, d.Summary = "local_validation", appErr.Message
	}
	task.FailureDiagnostics = generation.SanitizeTaskDiagnostics(d)
}
