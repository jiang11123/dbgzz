package diagnostics

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"time"
)

// AnalyzeBundle reads only exported evidence. It needs no application process,
// database, model access or network, and does not trust precomputed findings.
func AnalyzeBundle(data []byte) ([]Finding, error) {
	archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, err
	}
	c := &collection{}
	var manifest manifest
	seen := map[string]bool{}
	var total uint64
	for _, file := range archive.File {
		if seen[file.Name] {
			return nil, errors.New("duplicate diagnostic file")
		}
		seen[file.Name] = true
		if file.UncompressedSize64 > (32<<20)-total {
			return nil, errors.New("diagnostic input exceeds read limit")
		}
		total += file.UncompressedSize64
		var target any
		switch file.Name {
		case "manifest.json":
			target = &manifest
		case "backend/tasks.jsonl":
			target = &c.Tasks
		case "backend/canvas-bindings.jsonl":
			target = &c.CanvasBindings
		case "client/events.jsonl":
			target = &c.ClientEvents
		case "backend/events.jsonl":
			target = &c.BackendEvents
		case "backend/assistant-turns.jsonl":
			target = &c.AssistantTurns
		case "backend/assistant-runtime.jsonl":
			target = &c.AssistantEvidence
		case "backend/resources.jsonl":
			target = &c.Resources
		default:
			continue
		}
		reader, err := file.Open()
		if err != nil {
			return nil, err
		}
		body, err := io.ReadAll(io.LimitReader(reader, 32<<20+1))
		reader.Close()
		if err != nil {
			return nil, err
		}
		if file.Name == "manifest.json" {
			err = json.Unmarshal(body, target)
		} else {
			err = decodeJSONL(body, target)
		}
		if err != nil {
			return nil, fmt.Errorf("invalid diagnostic file %s: %w", file.Name, err)
		}
	}
	if manifest.SchemaVersion != SchemaVersion || manifest.Collectors == nil {
		return nil, errors.New("schema 3 manifest required")
	}
	c.Collectors = manifest.Collectors
	// A removed file cannot silently masquerade as an empty successful source.
	for name, path := range map[string]string{"tasks": "backend/tasks.jsonl", "canvasBindings": "backend/canvas-bindings.jsonl", "clientEvents": "client/events.jsonl", "backendEvents": "backend/events.jsonl", "assistantTurns": "backend/assistant-turns.jsonl", "assistantRuntime": "backend/assistant-runtime.jsonl", "resources": "backend/resources.jsonl"} {
		if !seen[path] {
			c.Collectors[name] = CollectorCoverage{Status: "failed", Scope: "bundle", Reason: "evidence_file_missing"}
		}
	}
	return analyze(c), nil
}

func decodeJSONL(body []byte, target any) error {
	var rows []json.RawMessage
	decoder := json.NewDecoder(bytes.NewReader(body))
	for {
		var row json.RawMessage
		err := decoder.Decode(&row)
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		rows = append(rows, row)
	}
	encoded, err := json.Marshal(rows)
	if err != nil {
		return err
	}
	return json.Unmarshal(encoded, target)
}

func analyze(c *collection) []Finding {
	findings := []Finding{}
	add := func(status, stage, reason, explanation string, refs, missing []string) {
		findings = append(findings, Finding{ID: fmt.Sprintf("finding-%03d", len(findings)+1), Status: status, Stage: stage, Reason: reason, Explanation: explanation, EvidenceRefs: refs, MissingEvidence: missing})
	}
	for _, task := range c.Tasks {
		ref := recordRef("backend/tasks.jsonl", task.ID)
		if task.Status != "failed" {
			continue
		}
		diagnostic := task.FailureDiagnostics
		switch {
		case diagnostic != nil && diagnostic.Source == "local_network":
			stage := "local_network"
			if diagnostic.TransportPhase != "" && diagnostic.TransportPhase != "unknown" {
				stage += "/" + diagnostic.TransportPhase
			}
			add("confirmed", stage, "local_network_failed", "记录确认本机访问外部服务时发生网络故障；已有上游任务应继续查询原任务，不能据此认定模型生成失败。", []string{ref}, nil)
		case diagnostic != nil && diagnostic.Source == "upstream_response" && diagnostic.HTTPStatus < 400:
			add("confirmed", diagnostic.Stage, "upstream_business_failed", "上游已返回业务失败；HTTP 成功不代表生成成功，素材读取失败也不等于用户电脑下载失败。", []string{ref}, nil)
		case diagnostic != nil && diagnostic.Source == "reference_upload":
			stage := "reference_upload"
			if diagnostic.FailedOperation != "" && diagnostic.FailedOperation != "unknown" {
				stage = diagnostic.FailedOperation
			}
			if diagnostic.TransportPhase != "" && diagnostic.TransportPhase != "unknown" {
				stage += "/" + diagnostic.TransportPhase
			} else if diagnostic.FailedOperation != "" {
				for i := len(diagnostic.Requests) - 1; i >= 0; i-- {
					request := diagnostic.Requests[i]
					if request.Operation == diagnostic.FailedOperation {
						if request.TransportPhase != "" && request.TransportPhase != "unknown" {
							stage += "/" + request.TransportPhase
						}
						break
					}
				}
			}
			add("confirmed", stage, "reference_preparation_failed", "记录确认参考素材准备失败，尚未进入后续生成提交；连接阶段说明失败位置，不能单凭这一点判定是哪一方网络故障。", []string{ref}, nil)
		case diagnostic != nil && diagnostic.Source == "local_result" && diagnostic.ExecutionResult == "completed":
			add("confirmed", "result_delivery", "local_result_failed", "模型已完成，任务记录确认本地结果处理失败；应继续取回原任务，避免重复生成。", []string{ref}, nil)
		case diagnostic != nil && diagnostic.HTTPStatus >= 400 && (diagnostic.Source == "upstream_http" || diagnostic.Source == "upstream_response"):
			add("confirmed", "upstream", "upstream_request_failed", "任务记录确认上游请求失败；是否扣费仍需对应账单证据。", []string{ref}, nil)
		default:
			add("inconclusive", "generation", "failed_task_cause_unknown", "任务已失败，但当前证据不能确定具体原因。", []string{ref}, []string{"structured_failure_reason"})
		}
	}
	for _, event := range c.ClientEvents {
		if event.Code == "turn_interrupted" && event.AssistantTurnID != "" {
			add("confirmed", "assistant", "assistant_interrupted", "客户端记录确认助手轮次曾中断；仍需后续恢复记录判断是否恢复。", []string{recordRef("client/events.jsonl", event.ID)}, nil)
		}
		if event.Code == "generation_bind_refused" && event.Reason != "" {
			confirmed := false
			for _, later := range c.ClientEvents {
				if later.Code == "generation_bind_confirmed" && sameBinding(event, later) && eventAfter(later.Timestamp, event.Timestamp) {
					confirmed = true
					break
				}
			}
			if !confirmed {
				add("confirmed", "canvas_binding", event.Reason, "结果绑定曾被拒绝，包内未记录同一节点随后绑定成功；该记录只能确认绑定阶段的问题。", []string{recordRef("client/events.jsonl", event.ID)}, []string{"subsequent_binding_receipt"})
			}
		}
		if event.Media != nil && event.Media.ErrorCode != nil && *event.Media.ErrorCode > 0 {
			add("confirmed", "playback", "media_element_error", "播放器记录了媒体错误；不能据此断定上游生成失败。", []string{recordRef("client/events.jsonl", event.ID)}, nil)
		}
	}
	for _, event := range c.BackendEvents {
		if event.Phase == "start" && event.SpanID != "" {
			ended := false
			for _, end := range c.BackendEvents {
				if end.Phase == "end" && end.TraceID == event.TraceID && end.SpanID == event.SpanID {
					ended = true
					break
				}
			}
			if !ended {
				add("inconclusive", event.Name, "operation_end_not_recorded", "已记录步骤开始，未记录结束；可能仍在运行、进程退出或结束记录缺失，不能仅凭这一点确认故障。", []string{recordRef("backend/events.jsonl", event.ID)}, []string{"operation_end_or_recovery_event"})
			}
		}
		if event.Phase != "end" || event.Status != "error" || event.Reason == "" {
			continue
		}
		if event.Name == "generation.download" && event.Reason == "download_not_started" {
			add("inconclusive", "result_download", "download_not_started", "本次取回在开始前停止，不能据此判断下载失败，也不能把先前失败标为已恢复。", []string{recordRef("backend/events.jsonl", event.ID)}, nil)
			continue
		}
		stage := ""
		switch event.Name {
		case "generation.download":
			stage = "result_download"
		case "generation.persist":
			stage = "result_persistence"
		case "canvas.bind":
			stage = "canvas_binding"
		default:
			continue
		}
		recovered := false
		for _, later := range c.BackendEvents {
			if later.Name == event.Name && later.Phase == "end" && later.Status == "ok" && later.TaskID == event.TaskID && later.NodeID == event.NodeID && later.OperationID == event.OperationID && later.Timestamp.After(event.Timestamp) {
				recovered = true
				break
			}
		}
		if !recovered {
			add("confirmed", stage, event.Reason, "持久记录确认该步骤曾失败，包内未记录同一操作随后成功；不能据此推断未记录的后续行为。", []string{recordRef("backend/events.jsonl", event.ID)}, nil)
		}
	}
	for _, resource := range c.Resources {
		if resource.Storage == "local" && resource.Status == "ready" && (resource.FileStatus == "missing" || (resource.FileSize != nil && *resource.FileSize == 0)) {
			add("confirmed", "local_resource", "ready_resource_file_missing", "资源被标记为可用，但导出时本地文件不存在或为空。", []string{recordRef("backend/resources.jsonl", resource.ID)}, nil)
		}
	}
	ownedSessions := map[string]bool{}
	for _, turn := range c.AssistantTurns {
		if turn.SessionID != "" && turn.CanvasID != "" {
			ownedSessions[turn.SessionID+"|"+turn.CanvasID] = true
		}
	}
	for _, evidence := range c.AssistantEvidence {
		if ownedSessions[evidence.SessionID+"|"+evidence.CanvasID] {
			stage, reason, explanation, missingReason := "", "", "", ""
			switch {
			case evidence.Kind == "tool" && evidence.Status == "failed":
				stage, reason, missingReason = "assistant_tool", "assistant_tool_failed", "tool_failure_reason"
				explanation = "所属助手会话的工具记录确认这次操作失败；不能把其他操作随后成功当作这次操作已恢复，也不能据此认定完整故障原因。"
			case evidence.Kind == "model_call" && evidence.Name == "model.response" && evidence.Status == "error":
				stage, reason, missingReason = "assistant_model", "model_attempt_failed", "model_failure_reason"
				explanation = "所属助手会话的模型响应记录确认这次尝试失败；这不证明进程崩溃或重开后无法操作。"
			}
			if stage != "" {
				missing := []string{}
				if evidence.TurnID == "" {
					missing = append(missing, "assistant_turn_link")
					explanation += "历史记录缺少确切轮次关联。"
				}
				if code := sanitizeAssistantFailureReason(evidence.FailureReason); code != "" {
					reason = code
				} else {
					missing = append(missing, missingReason)
				}
				add("confirmed", stage, reason, explanation, []string{recordRef("backend/assistant-runtime.jsonl", evidence.ID)}, missing)
			}
		}
		if ownedSessions[evidence.SessionID+"|"+evidence.CanvasID] && evidence.Kind == "model_call" && evidence.Name == "model.response" && (evidence.Status == "aborted" || evidence.Status == "interrupted") {
			add("confirmed", "assistant_model", "model_attempt_interrupted", "所属助手会话的模型响应记录确认这次模型尝试已中断；不能据此确定进程崩溃、未关联的业务轮次或重开后的操作状态。", []string{recordRef("backend/assistant-runtime.jsonl", evidence.ID)}, nil)
		}
		if evidence.TurnID != "" && evidence.Kind == "recovery" && (evidence.Status == "interrupted" || evidence.Status == "aborted" || evidence.Reason == "process_interrupted") {
			add("confirmed", "assistant", "assistant_interrupted", "助手记录确认执行曾中断；这不证明重开后无法操作，也不代表工具操作已回滚。", []string{recordRef("backend/assistant-runtime.jsonl", evidence.ID)}, nil)
		}
	}
	for _, turn := range c.AssistantTurns {
		if turn.State == "open" {
			add("inconclusive", "assistant", "assistant_turn_unsettled", "助手轮次尚未结算；缺少中断或恢复证据时不能判断是运行中、退出还是故障。", []string{recordRef("backend/assistant-turns.jsonl", turn.ID)}, []string{"assistant_execution_or_recovery_event"})
		}
	}
	missing := []string{}
	for name, coverage := range c.Collectors {
		if coverage.Status != "complete" {
			missing = append(missing, name+":"+coverage.Status)
		}
	}
	sort.Strings(missing)
	if len(missing) > 0 {
		add("inconclusive", "collection", "evidence_incomplete", "部分记录未采集、已过期或被截断；没有记录不代表没有发生。", []string{"manifest.json#/collectors"}, missing)
	}
	if len(findings) == 0 {
		add("inconclusive", "unknown", "no_confirmed_failure", "包内没有足以确认故障原因的记录；需要故障时的执行和显示证据。", []string{"manifest.json"}, []string{"failure_time_evidence"})
	}
	return findings
}

func recordRef(path, id string) string {
	if id == "" {
		return path
	}
	return path + "#" + id
}

func sameBinding(a, b clientEventRecord) bool {
	if a.TaskID == "" || a.TaskID != b.TaskID {
		return false
	}
	if a.CanvasBinding == nil || b.CanvasBinding == nil || a.CanvasBinding.NodeID == "" {
		return false
	}
	return a.CanvasBinding.NodeID == b.CanvasBinding.NodeID && a.CanvasBinding.ClientOperationID == b.CanvasBinding.ClientOperationID
}

func eventAfter(after, before string) bool {
	a, e1 := time.Parse(time.RFC3339Nano, after)
	b, e2 := time.Parse(time.RFC3339Nano, before)
	return e1 == nil && e2 == nil && !a.Before(b)
}
