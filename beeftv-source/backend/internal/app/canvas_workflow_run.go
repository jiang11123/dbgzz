package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"gorm.io/gorm"
	cw "infinite-canvas/backend/internal/canvasworkflow"
	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
)

func (s *Service) StartCanvasWorkflow(user, id string, req cw.RunRequest) (cw.Run, error) {
	s.canvasWorkflowMu.Lock()
	defer s.canvasWorkflowMu.Unlock()
	if s.IsDraining() {
		return cw.Run{}, workflowBad("应用正在退出，请稍后重试")
	}
	if strings.TrimSpace(req.ClientOperationID) == "" || len(req.ClientOperationID) > 128 {
		return cw.Run{}, workflowBad("缺少有效的本次运行标识")
	}
	req.TemplateRevision = workflowRevision(req.TemplateRevision)
	raw, _ := json.Marshal(struct {
		Template string
		Inputs   map[string]cw.Value
		Revision int
	}{id, req.Inputs, req.TemplateRevision})
	digest := sha256.Sum256(raw)
	hash := hex.EncodeToString(digest[:])
	var old model.CanvasWorkflowRun
	e := s.repo.DB().Where("user_id = ? AND client_operation_id = ?", user, req.ClientOperationID).First(&old).Error
	if e == nil {
		if old.RequestHash != hash {
			// Before revision pinning, revision 1 requests hashed only template and inputs.
			legacyRaw, _ := json.Marshal(struct {
				Template string
				Inputs   map[string]cw.Value
			}{id, req.Inputs})
			legacyDigest := sha256.Sum256(legacyRaw)
			if req.TemplateRevision != 1 || workflowRevision(old.TemplateRevision) != 1 || old.RequestHash != hex.EncodeToString(legacyDigest[:]) {
				return cw.Run{}, workflowBad("本次运行标识已用于不同输入，请重新确认运行")
			}
		}
		return workflowRun(old)
	}
	if !errors.Is(e, gorm.ErrRecordNotFound) {
		return cw.Run{}, e
	}
	template, e := s.workflowRevisionRow(user, id, req.TemplateRevision)
	if e != nil {
		return cw.Run{}, e
	}
	public, e := workflowTemplate(template)
	if e != nil {
		return cw.Run{}, e
	}
	order, e := cw.Validate(public.Definition)
	if e != nil {
		return cw.Run{}, e
	}
	knownInputs := map[string]bool{}
	run := cw.Run{Status: "queued", Steps: []cw.Step{}, Outputs: []cw.Output{}}
	refs := map[string]bool{}
	for _, n := range order {
		step := cw.Step{NodeID: n.ID, Title: n.Title, Status: "pending"}
		if n.Role == "input" || n.Role == "constant" {
			v := cw.Value{ResourceID: n.ResourceID, Text: n.Text}
			if n.Role == "input" {
				knownInputs[n.ID] = true
				if override, ok := req.Inputs[n.ID]; ok {
					v = override
				}
			}
			if n.MediaType == "text" {
				if strings.TrimSpace(v.Text) == "" || len(v.Text) > 100000 {
					return cw.Run{}, workflowBad("请输入有效文本：" + n.Title)
				}
				v.ResourceID = ""
			} else {
				if _, e = s.workflowResource(user, v.ResourceID, n.MediaType); e != nil {
					return cw.Run{}, e
				}
				refs[v.ResourceID] = true
				v.Text = ""
			}
			step.Status = "succeeded"
			step.ResourceID = v.ResourceID
			step.Text = v.Text
		}
		run.Steps = append(run.Steps, step)
	}
	for key := range req.Inputs {
		if !knownInputs[key] {
			return cw.Run{}, workflowBad("输入不属于此工作流或不允许替换：" + key)
		}
	}
	// Template references protect every revision, but admission must only depend
	// on this revision's immutable recipe and definition.
	plain, e := s.decryptSettingSecret(template.RecipeCipher)
	if e != nil {
		return cw.Run{}, e
	}
	var frozenRecipes workflowRecipes
	if e = json.Unmarshal([]byte(plain), &frozenRecipes); e != nil {
		return cw.Run{}, e
	}
	frozenIDs := map[string]bool{}
	for _, recipe := range frozenRecipes {
		for resource := range workflowResourceIDs(recipe.Request.Input) {
			frozenIDs[resource] = true
		}
	}
	for _, n := range public.Definition.Nodes {
		if n.ResourceID != "" {
			frozenIDs[n.ResourceID] = true
		}
	}
	for resource := range frozenIDs {
		if _, e = s.workflowResource(user, resource, ""); e != nil {
			return cw.Run{}, e
		}
		refs[resource] = true
	}
	state, _ := json.Marshal(run)
	row := model.CanvasWorkflowRun{ID: newID(), TemplateRevision: req.TemplateRevision, UserID: user, ClientOperationID: req.ClientOperationID, RequestHash: hash, TemplateID: id, TemplateName: template.Name, DefinitionJSON: template.DefinitionJSON, RecipeCipher: template.RecipeCipher, StateJSON: string(state), Status: run.Status}
	e = s.repo.DB().Transaction(func(tx *gorm.DB) error {
		if e := tx.Create(&row).Error; e != nil {
			return e
		}
		rows := workflowReferenceRows(row.ID, user, refs)
		return persistWorkflowReferences(tx, rows)
	})
	if e != nil {
		return cw.Run{}, e
	}
	return workflowRun(row)
}

func (s *Service) startCanvasWorkflowScheduler(ctx context.Context) {
	s.canvasWorkflowMu.Lock()
	if s.canvasWorkflowLoop {
		s.canvasWorkflowMu.Unlock()
		return
	}
	s.canvasWorkflowLoop = true
	s.canvasWorkflowMu.Unlock()
	if !s.runWorkerLoop(func(workerCtx context.Context) {
		defer func() { s.canvasWorkflowMu.Lock(); s.canvasWorkflowLoop = false; s.canvasWorkflowMu.Unlock() }()
		timer := time.NewTicker(time.Second)
		defer timer.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-workerCtx.Done():
				return
			case <-timer.C:
				s.advanceCanvasWorkflows(workerCtx)
			}
		}
	}) {
		s.canvasWorkflowMu.Lock()
		s.canvasWorkflowLoop = false
		s.canvasWorkflowMu.Unlock()
	}
}

func (s *Service) saveCanvasWorkflowRun(row *model.CanvasWorkflowRun, run cw.Run) error {
	state, e := json.Marshal(run)
	if e != nil {
		return e
	}
	row.StateJSON = string(state)
	row.Status = run.Status
	return s.repo.DB().Save(row).Error
}

func (s *Service) advanceCanvasWorkflows(ctx context.Context) {
	s.canvasWorkflowMu.Lock()
	defer s.canvasWorkflowMu.Unlock()
	if ctx.Err() != nil || s.IsDraining() {
		return
	}
	var rows []model.CanvasWorkflowRun
	if s.repo.DB().Where("status IN ?", []string{"queued", "running"}).Order("created_at ASC").Find(&rows).Error != nil {
		return
	}
	for i := range rows {
		if ctx.Err() != nil || s.IsDraining() {
			return
		}
		s.advanceCanvasWorkflow(&rows[i])
	}
}

func workflowOperation(run, node string) string {
	sum := sha256.Sum256([]byte(run + ":" + node))
	return "canvas-workflow:" + hex.EncodeToString(sum[:])
}

func (s *Service) advanceCanvasWorkflow(row *model.CanvasWorkflowRun) {
	run, e := workflowRun(*row)
	fail := func(message string) {
		run.Status, run.Error = "failed", message
		_ = s.saveCanvasWorkflowRun(row, run)
	}
	if e != nil {
		fail("工作流运行记录无法读取，请检查运行记录")
		return
	}
	var d cw.Definition
	if json.Unmarshal([]byte(row.DefinitionJSON), &d) != nil {
		fail("工作流定义无法读取，请重新保存模板")
		return
	}
	plain, e := s.decryptSettingSecret(row.RecipeCipher)
	if e != nil {
		fail("无法读取工作流配方，请重新保存模板")
		return
	}
	var recipes workflowRecipes
	if json.Unmarshal([]byte(plain), &recipes) != nil {
		fail("工作流配方无法读取，请重新保存模板")
		return
	}
	nodes := map[string]cw.Node{}
	steps := map[string]*cw.Step{}
	for _, n := range d.Nodes {
		nodes[n.ID] = n
	}
	for i := range run.Steps {
		steps[run.Steps[i].NodeID] = &run.Steps[i]
	}
	run.Status = "running"
	run.Error = ""
	for i := range run.Steps {
		step := &run.Steps[i]
		n := nodes[step.NodeID]
		if n.Role == "constant" || n.Role == "input" || step.Status == "succeeded" {
			continue
		}
		if step.Status == "failed" {
			run.Status = "failed"
			run.Error = step.Error
			break
		}
		ready := true
		for _, edge := range d.Edges {
			if edge.To == n.ID && steps[edge.From].Status != "succeeded" {
				ready = false
			}
		}
		if !ready {
			continue
		}
		if n.OperationID == "image.select" {
			step.Candidates = workflowImageCandidates(n, d, steps)
			if len(step.Candidates) == 1 {
				step.ResourceID, step.Status = step.Candidates[0].ResourceID, "succeeded"
			} else if len(step.Candidates) > 1 {
				step.Status = "waiting_selection"
			} else {
				step.Status, step.Error, run.Status, run.Error = "failed", "上游没有可选择的图片", "failed", "上游没有可选择的图片"
			}
			if s.saveCanvasWorkflowRun(row, run) != nil {
				return
			}
			continue
		}
		var task *model.Task
		if step.TaskID != "" {
			task, e = s.repo.TaskForUser(row.UserID, step.TaskID)
		} else {
			op := workflowOperation(row.ID, n.ID)
			task, e = s.repo.TaskByClientOperation(row.UserID, op)
			if e == nil && task == nil {
				if strings.HasSuffix(n.OperationID, ".ai-upscale") || n.OperationID == "image.describe" {
					resource := ""
					for _, edge := range d.Edges {
						if edge.To == n.ID {
							resource = steps[edge.From].ResourceID
						}
					}
					if strings.HasSuffix(n.OperationID, ".ai-upscale") {
						task, e = s.executeWorkflowUpscale(row.UserID, op, n, resource)
					} else {
						var request CreateTaskRequest
						request, e = s.workflowDescribeRequest(n, resource, op)
						if e == nil {
							task, e = s.CreateTask(row.UserID, request)
						}
					}
				} else if cw.IsMediaOperation(n.OperationID) {
					resource := ""
					for _, edge := range d.Edges {
						if edge.To == n.ID {
							resource = steps[edge.From].ResourceID
						}
					}
					task, e = s.taskDomain().CreateCanvasMediaTask(row.UserID, n, resource, op)
				} else if n.OperationID == "video.trim" || n.OperationID == "video.merge" {
					task, e = s.executeCanvasWorkflowMedia(row.UserID, op, n, d.Edges, steps)
				} else if n.Role == "depth" || n.OperationID == "video.depth" {
					resource := ""
					for _, edge := range d.Edges {
						if edge.To == n.ID {
							resource = steps[edge.From].ResourceID
						}
					}
					task, e = s.CreateDepthCaptureTask(row.UserID, DepthCaptureCreateRequest{ResourceID: resource, ClientOperationID: op})
				} else {
					recipe, ok := recipes[n.ID]
					if !ok {
						e = workflowBad("生成配方缺失")
					} else {
						var req CreateTaskRequest
						req, e = s.materializeCanvasWorkflowRequest(row.UserID, op, recipe, nodes, steps)
						if e == nil {
							task, e = s.CreateTask(row.UserID, req)
						}
						if e != nil {
							videos := []string{}
							seen := map[string]bool{}
							for _, binding := range recipe.Bindings {
								if binding.Field != "referenceVideos" || seen[binding.NodeID] {
									continue
								}
								seen[binding.NodeID] = true
								if value := steps[binding.NodeID]; value != nil {
									if resource, err := s.workflowResource(row.UserID, value.ResourceID, "video"); err == nil {
										videos = append(videos, fmt.Sprintf("%s（%.2f 秒）", nodes[binding.NodeID].Title, float64(resource.DurationMs)/1000))
									}
								}
							}
							e = fmt.Errorf("模型 %s；参考视频：%s；%w", recipe.Request.Model, strings.Join(videos, "、"), e)
						}
					}
				}
			}
		}
		if e != nil {
			step.Status = "failed"
			step.Error = "无法执行此步骤：" + safePersistedFailureMessage(e.Error(), "")
			run.Status = "failed"
			run.Error = step.Error
			break
		}
		if task == nil {
			step.Status = "failed"
			step.Error = "原任务记录缺失，停止自动提交；请检查任务记录"
			run.Status = "failed"
			run.Error = step.Error
			break
		}
		step.TaskID = task.ID
		step.Status = "running"
		switch task.Status {
		case model.TaskStatusFailed, model.TaskStatusCancelled:
			step.Status = "failed"
			step.Error = safePersistedFailureMessage(task.Error, task.Stage)
			if step.Error == "" {
				step.Error = "任务已失败或取消"
			}
			run.Status = "failed"
			run.Error = step.Error
		case model.TaskStatusSucceeded:
			if nodes[step.NodeID].MediaType == "text" {
				step.Text = workflowTextOutput(task)
				if step.Text != "" {
					step.Status = "succeeded"
				}
			} else {
				step.Candidates = nil
				storedValues, _ := s.generationDeliverer().LoadedOutputs(task.ID)
				storedValues = append(localtask.CanonicalOutputs(task.ResultJSON, task.Type), storedValues...)
				seen := map[string]bool{}
				readyOutputs := map[int]bool{}
				{
					for _, value := range storedValues {
						if value.MediaType == n.MediaType && value.ResourceID != "" {
							if _, err := s.workflowResource(row.UserID, value.ResourceID, n.MediaType); err != nil {
								continue
							}
							readyOutputs[value.OutputIndex] = true
							if seen[value.ResourceID] {
								continue
							}
							ref := model.CanvasWorkflowResource{OwnerID: row.ID, UserID: row.UserID, ResourceID: value.ResourceID}
							if s.repo.DB().Where("owner_id = ? AND resource_id = ?", row.ID, value.ResourceID).FirstOrCreate(&ref).Error != nil {
								continue
							}
							step.Candidates = append(step.Candidates, cw.Value{ResourceID: value.ResourceID})
							seen[value.ResourceID] = true
						}
					}
				}
				if n.MediaType == "image" && len(localtask.CanonicalOutputs(task.ResultJSON, task.Type)) > len(readyOutputs) && len(localtask.CanonicalOutputs(task.ResultJSON, task.Type)) > 1 {
					step.Status = "running"
				} else if n.MediaType == "image" && len(step.Candidates) > 1 {
					step.Status, step.ResourceID = "succeeded", ""
					for _, edge := range d.Edges {
						if edge.From == n.ID && nodes[edge.To].OperationID != "image.select" {
							step.Status, step.Error, run.Status, run.Error = "failed", "多张图片需先经过选择图片结果", "failed", "多张图片需先经过选择图片结果"
						}
					}
				} else {
					id := workflowOutputResource(task.ResultJSON)
					stored, loadErr := s.generationDeliverer().LoadedOutputs(task.ID)
					if id == "" && loadErr == nil {
						for _, output := range stored {
							if output.MediaType == n.MediaType && output.ResourceID != "" {
								id = output.ResourceID
								break
							}
						}
					}
					if id != "" {
						if _, e = s.workflowResource(row.UserID, id, n.MediaType); e == nil {
							step.ResourceID = id
							step.Status = "succeeded"
							ref := model.CanvasWorkflowResource{OwnerID: row.ID, UserID: row.UserID, ResourceID: id}
							if e = s.repo.DB().Where("owner_id = ? AND resource_id = ?", row.ID, id).FirstOrCreate(&ref).Error; e != nil {
								step.Status = "running"
							}
						}
					}
				}
			}
			if step.Status != "succeeded" && (deliveryPaused(task.Stage) || nodes[step.NodeID].MediaType == "text" || len(localtask.CanonicalOutputs(task.ResultJSON, task.Type)) == 0) {
				step.Status = "failed"
				step.Error = "任务完成但持久结果不可用，请在任务列表检查并恢复结果"
				run.Status = "failed"
				run.Error = step.Error
			}
		}
		// Persist each admitted task before scheduling a dependent step. The stable
		// operation ID reconciles a crash between admission and this checkpoint.
		if s.saveCanvasWorkflowRun(row, run) != nil {
			return
		}
		if run.Status == "failed" {
			break
		}
	}
	all := true
	run.Outputs = []cw.Output{}
	for _, step := range run.Steps {
		if step.Status != "succeeded" {
			all = false
		}
	}
	for _, id := range d.OutputNodeIDs {
		step := steps[id]
		if step != nil && step.Status == "succeeded" {
			if step.ResourceID == "" && len(step.Candidates) > 1 {
				for _, value := range step.Candidates {
					run.Outputs = append(run.Outputs, cw.Output{NodeID: id, MediaType: nodes[id].MediaType, ResourceID: value.ResourceID})
				}
			} else {
				run.Outputs = append(run.Outputs, cw.Output{NodeID: id, MediaType: nodes[id].MediaType, ResourceID: step.ResourceID, Text: step.Text})
			}
		}
	}
	if all {
		run.Status = "succeeded"
	}
	_ = s.saveCanvasWorkflowRun(row, run)
}

func workflowOutputResource(raw string) string {
	var v any
	if json.Unmarshal([]byte(raw), &v) != nil {
		return ""
	}
	var walk func(any) string
	walk = func(v any) string {
		switch x := v.(type) {
		case map[string]any:
			if id := workflowReferenceID(x); id != "" {
				return id
			}
			for _, key := range []string{"images", "videos", "audios", "outputs", "result", "data", "video", "audio", "image"} {
				if id := walk(x[key]); id != "" {
					return id
				}
			}
		case []any:
			for _, item := range x {
				if id := walk(item); id != "" {
					return id
				}
			}
		}
		return ""
	}
	return walk(v)
}

func workflowTextOutput(task *model.Task) string {
	var v map[string]any
	_ = json.Unmarshal([]byte(task.ResultJSON), &v)
	for _, key := range []string{"text", "content", "output"} {
		if text, ok := v[key].(string); ok && text != "" {
			return text
		}
	}
	return task.TextDraft
}

func (s *Service) RetryCanvasWorkflow(user, id string) (cw.Run, error) {
	s.canvasWorkflowMu.Lock()
	defer s.canvasWorkflowMu.Unlock()
	var row model.CanvasWorkflowRun
	if e := s.repo.DB().Where("user_id = ? AND id = ?", user, id).First(&row).Error; e != nil {
		return cw.Run{}, workflowNotFound()
	}
	run, e := workflowRun(row)
	if e != nil {
		return cw.Run{}, e
	}
	if run.Status != "failed" {
		return cw.Run{}, workflowBad("只有失败的运行可以重试")
	}
	for i := range run.Steps {
		step := &run.Steps[i]
		if step.Status != "failed" {
			continue
		}
		if step.TaskID != "" {
			task, e := s.repo.TaskForUser(user, step.TaskID)
			if e != nil {
				return cw.Run{}, e
			}
			if task.Status != model.TaskStatusQueued && task.Status != model.TaskStatusRunning {
				if generation.UpscaleMediaType(task.Model) != "" {
					task, e = s.RecoverMediaUpscale(context.Background(), user, step.TaskID)
					if e != nil {
						return cw.Run{}, e
					}
				} else {
					input, prepareErr := s.prepareCanvasWorkflowRetryCredentials(row, step.NodeID, task)
					if prepareErr != nil {
						return cw.Run{}, prepareErr
					}
					if input != "" {
						task, e = s.taskDomain().RetryWithCredentialRefresh(user, step.TaskID, task.InputJSON, input)
					} else {
						task, e = s.RetryTask(user, step.TaskID)
					}
					if e != nil {
						return cw.Run{}, e
					}
				}
			}
			step.TaskID = task.ID
		}
		step.Status = "pending"
		step.Error = ""
	}
	run.Status = "queued"
	run.Error = ""
	if e = s.saveCanvasWorkflowRun(&row, run); e != nil {
		return cw.Run{}, e
	}
	return workflowRun(row)
}

func (s *Service) CancelCanvasWorkflow(ctx context.Context, user, id string) (cw.Run, error) {
	s.canvasWorkflowMu.Lock()
	defer s.canvasWorkflowMu.Unlock()
	var row model.CanvasWorkflowRun
	if e := s.repo.DB().Where("user_id = ? AND id = ?", user, id).First(&row).Error; e != nil {
		return cw.Run{}, workflowNotFound()
	}
	run, e := workflowRun(row)
	if e != nil {
		return cw.Run{}, e
	}
	if run.Status == "succeeded" || run.Status == "cancelled" {
		return run, nil
	}
	run.Status = "cancelled"
	for i := range run.Steps {
		step := &run.Steps[i]
		if step.Status == "pending" || step.Status == "running" || step.Status == "waiting_selection" {
			if step.TaskID == "" {
				task, lookupErr := s.repo.TaskByClientOperation(user, workflowOperation(row.ID, step.NodeID))
				if lookupErr != nil {
					return cw.Run{}, lookupErr
				}
				if task != nil {
					step.TaskID = task.ID
				}
			}
			if step.TaskID != "" {
				if _, e = s.CancelTask(ctx, user, step.TaskID); e != nil {
					step.Error = "已停止后续步骤；当前上游任务无法立即取消，请在任务列表查看"
				}
			}
			step.Status = "cancelled"
		}
	}
	if e = s.saveCanvasWorkflowRun(&row, run); e != nil {
		return cw.Run{}, e
	}
	return workflowRun(row)
}
