package project

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"infinite-canvas/backend/internal/assets"
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/gorm"
)

const builtinShortDramaWorkflowKey = "short-drama-production"
const builtinShortDramaWorkflowVersion = 2

type workflowStepDefinition struct {
	Key  string `json:"key"`
	Name string `json:"name"`
}

var builtinShortDramaSteps = []workflowStepDefinition{
	{Key: "story", Name: "剧情与章节"},
	{Key: "assets", Name: "资产拆分"},
	{Key: "storyboard", Name: "分镜脚本"},
	{Key: "previz", Name: "黑白动作预演"},
	{Key: "video", Name: "视频生成"},
	{Key: "delivery", Name: "交付与打包"},
}

func (s *Service) EnsureBuiltinTemplate() error {
	if _, err := s.repo.WorkflowTemplateVersion(builtinShortDramaWorkflowKey, builtinShortDramaWorkflowVersion); err == nil {
		return nil
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return err
	}
	definition, err := json.Marshal(map[string]any{"scope": []string{"project", "unit"}, "steps": builtinShortDramaSteps})
	if err != nil {
		return err
	}
	template := model.WorkflowTemplateVersion{ID: kernel.NewID(), TemplateKey: builtinShortDramaWorkflowKey, Name: "短剧分镜工作流", Version: builtinShortDramaWorkflowVersion, DefinitionJSON: string(definition), CreatedAt: time.Now()}
	return s.repo.CreateWorkflowTemplateVersion(&template)
}

func (s *Service) PrepareDefaultWorkflow(projectID string) (WorkflowSeed, error) {
	instance, steps, err := s.newWorkflowRecords(projectID, "", "project")
	if err != nil {
		return WorkflowSeed{}, err
	}
	return WorkflowSeed{Instance: instance, Steps: steps}, nil
}

func (s *Service) newWorkflowRecords(projectID string, unitID string, scope string) (model.WorkflowInstance, []model.WorkflowStepInstance, error) {
	template, err := s.repo.WorkflowTemplateVersion(builtinShortDramaWorkflowKey, builtinShortDramaWorkflowVersion)
	if err != nil {
		return model.WorkflowInstance{}, nil, err
	}
	now := time.Now()
	instance := model.WorkflowInstance{ID: kernel.NewID(), ProjectID: projectID, UnitID: unitID, TemplateVersionID: template.ID, Scope: scope, Status: model.WorkflowStatusActive, Revision: 1, CreatedAt: now, UpdatedAt: now}
	steps := make([]model.WorkflowStepInstance, 0, len(builtinShortDramaSteps))
	for index, definition := range builtinShortDramaSteps {
		status := model.WorkflowStepStatusPending
		if index == 0 {
			status = model.WorkflowStepStatusReady
		}
		steps = append(steps, model.WorkflowStepInstance{ID: kernel.NewID(), WorkflowInstanceID: instance.ID, StepKey: definition.Key, Name: definition.Name, Position: index, Status: status, InputJSON: "{}", OutputJSON: "{}", CreatedAt: now, UpdatedAt: now})
	}
	return instance, steps, nil
}

func (s *Service) ProjectWorkflows(userID string, projectID string) ([]WorkflowDetail, error) {
	if _, err := s.Owned(userID, projectID); err != nil {
		return nil, err
	}
	return s.workflowDetails(projectID)
}

func (s *Service) workflowDetails(projectID string) ([]WorkflowDetail, error) {
	instances, err := s.repo.ProjectWorkflowInstances(projectID)
	if err != nil {
		return nil, err
	}
	result := make([]WorkflowDetail, 0, len(instances))
	for _, instance := range instances {
		steps, stepsErr := s.repo.WorkflowSteps(instance.ID)
		if stepsErr != nil {
			return nil, stepsErr
		}
		result = append(result, WorkflowDetail{Instance: instance, Steps: steps})
	}
	return result, nil
}

func (s *Service) CreateUnitWorkflow(userID string, projectID string, unitID string) (WorkflowDetail, error) {
	if _, err := s.Active(userID, projectID); err != nil {
		return WorkflowDetail{}, err
	}
	if _, err := s.repo.ProjectUnit(projectID, unitID); err != nil {
		return WorkflowDetail{}, err
	}
	if err := s.EnsureBuiltinTemplate(); err != nil {
		return WorkflowDetail{}, err
	}
	instance, steps, err := s.newWorkflowRecords(projectID, unitID, "unit")
	if err != nil {
		return WorkflowDetail{}, err
	}
	storedSteps, err := s.repo.EnsureWorkflowInstanceAndBump(userID, projectID, &instance, steps)
	if err != nil {
		return WorkflowDetail{}, mapProjectWriteError(err)
	}
	return WorkflowDetail{Instance: instance, Steps: storedSteps}, nil
}

func (s *Service) UpdateWorkflowStep(userID string, projectID string, stepID string, req UpdateWorkflowStepRequest) (model.WorkflowStepInstance, error) {
	project, err := s.Active(userID, projectID)
	if err != nil {
		return model.WorkflowStepInstance{}, err
	}
	step, err := s.repo.WorkflowStepForProject(projectID, stepID)
	if err != nil {
		return model.WorkflowStepInstance{}, err
	}
	status := model.WorkflowStepStatus(strings.TrimSpace(req.Status))
	if !validWorkflowStepStatus(status) {
		return model.WorkflowStepInstance{}, kernel.BadAuthRequest("不支持的工作流步骤状态")
	}
	if !canTransitionWorkflowStep(step.Status, status) {
		return model.WorkflowStepInstance{}, kernel.BadAuthRequest("当前工作流步骤不能直接切换到目标状态")
	}
	if status == model.WorkflowStepStatusCompleted {
		instance, instanceErr := s.repo.WorkflowInstance(step.WorkflowInstanceID)
		if instanceErr != nil {
			return model.WorkflowStepInstance{}, instanceErr
		}
		if err := s.validateWorkflowStepCompletion(projectID, instance, step); err != nil {
			return model.WorkflowStepInstance{}, err
		}
	}
	stored, err := s.repo.UpdateWorkflowProgressActive(userID, projectID, step.ID, project.Revision, func(current repository.WorkflowProgressCurrent) (repository.WorkflowProgressPlan, error) {
		return planWorkflowStepUpdate(time.Now(), req, current)
	})
	if err != nil {
		return model.WorkflowStepInstance{}, mapProjectWriteError(err)
	}
	return stored, nil
}

func planWorkflowStepUpdate(now time.Time, req UpdateWorkflowStepRequest, current repository.WorkflowProgressCurrent) (repository.WorkflowProgressPlan, error) {
	status := model.WorkflowStepStatus(strings.TrimSpace(req.Status))
	if !validWorkflowStepStatus(status) {
		return repository.WorkflowProgressPlan{}, kernel.BadAuthRequest("不支持的工作流步骤状态")
	}
	if !canTransitionWorkflowStep(current.Step.Status, status) {
		return repository.WorkflowProgressPlan{}, kernel.BadAuthRequest("当前工作流步骤不能直接切换到目标状态")
	}
	step := current.Step
	step.Status = status
	step.OutputJSON = req.OutputJSON
	if strings.TrimSpace(step.OutputJSON) == "" {
		step.OutputJSON = "{}"
	}
	step.Error = strings.TrimSpace(req.Error)
	if status == model.WorkflowStepStatusRunning && step.StartedAt == nil {
		step.StartedAt = &now
	}
	if status == model.WorkflowStepStatusCompleted || status == model.WorkflowStepStatusSkipped {
		step.CompletedAt = &now
	} else {
		step.CompletedAt = nil
	}
	step.UpdatedAt = now
	instance := current.Instance
	if status == model.WorkflowStepStatusCompleted {
		if err := completionGateAllows(&instance, &step, current.Unit, current.Candidates, current.Shots, current.Artifacts); err != nil {
			return repository.WorkflowProgressPlan{}, err
		}
	}
	instance.Status = model.WorkflowStatusActive
	instance.Revision++
	instance.UpdatedAt = now
	var next *model.WorkflowStepInstance
	if status == model.WorkflowStepStatusCompleted || status == model.WorkflowStepStatusSkipped {
		if current.Next == nil {
			instance.Status = model.WorkflowStatusCompleted
		} else {
			nextCopy := *current.Next
			if nextCopy.Status == model.WorkflowStepStatusPending {
				nextCopy.Status = model.WorkflowStepStatusReady
				nextCopy.UpdatedAt = now
			}
			next = &nextCopy
		}
	} else if status == model.WorkflowStepStatusFailed {
		instance.Status = model.WorkflowStatusFailed
	}
	return repository.WorkflowProgressPlan{Step: &step, Next: next, Instance: &instance}, nil
}

func (s *Service) RegisterTaskOutput(userID string, projectID string, stepID string, req RegisterTaskOutputRequest) (model.WorkflowStepInstance, error) {
	if _, err := s.Active(userID, projectID); err != nil {
		return model.WorkflowStepInstance{}, err
	}
	task, err := s.repo.TaskForUser(userID, strings.TrimSpace(req.TaskID))
	if err != nil {
		return model.WorkflowStepInstance{}, err
	}
	canvasID := strings.TrimSpace(req.CanvasID)
	if task.ProjectID != projectID {
		canvas, canvasErr := s.repo.CanvasProjectForUser(userID, task.ProjectID)
		if canvasErr != nil || canvas.ProjectID != projectID {
			return model.WorkflowStepInstance{}, kernel.BadAuthRequest("任务不属于当前项目")
		}
		if canvasID != "" && canvasID != canvas.ID {
			return model.WorkflowStepInstance{}, kernel.BadAuthRequest("任务画布与产物画布不一致")
		}
		canvasID = canvas.ID
	}
	if canvasID != "" {
		canvas, canvasErr := s.repo.CanvasProjectForUser(userID, canvasID)
		if canvasErr != nil || canvas.ProjectID != projectID {
			return model.WorkflowStepInstance{}, kernel.BadAuthRequest("画布不属于当前项目")
		}
	}
	if task.Status != model.TaskStatusSucceeded {
		return model.WorkflowStepInstance{}, kernel.BadAuthRequest("只有成功任务才能登记产物")
	}
	step, err := s.repo.WorkflowStepForProject(projectID, stepID)
	if err != nil {
		return model.WorkflowStepInstance{}, err
	}
	if step.Status == model.WorkflowStepStatusFailed {
		return model.WorkflowStepInstance{}, kernel.BadAuthRequest("失败步骤不能登记成功产物")
	}
	unitID := strings.TrimSpace(req.UnitID)
	shotID := strings.TrimSpace(req.ShotID)
	var shot *model.Shot
	if shotID != "" {
		shot, err = s.repo.ShotForProject(projectID, shotID)
		if err != nil {
			return model.WorkflowStepInstance{}, err
		}
		if unitID == "" {
			unitID = shot.UnitID
		} else if unitID != shot.UnitID {
			return model.WorkflowStepInstance{}, kernel.BadAuthRequest("镜头不属于指定章节")
		}
	} else if unitID != "" {
		if _, err := s.repo.ProjectUnit(projectID, unitID); err != nil {
			return model.WorkflowStepInstance{}, err
		}
	}
	shotRevisionID := strings.TrimSpace(req.ShotRevisionID)
	if shot != nil {
		if shotRevisionID == "" {
			shotRevisionID = shot.CurrentRevisionID
		} else if _, revisionErr := s.repo.ShotRevisionForShot(shot.ID, shotRevisionID); revisionErr != nil {
			return model.WorkflowStepInstance{}, revisionErr
		}
	} else if shotRevisionID != "" {
		return model.WorkflowStepInstance{}, kernel.BadAuthRequest("镜头版本缺少所属镜头")
	}
	if versionID := strings.TrimSpace(req.AssetVersionID); versionID != "" {
		if _, err := s.repo.AssetVersionForProject(projectID, versionID); err != nil {
			return model.WorkflowStepInstance{}, err
		}
	}
	if resourceID := strings.TrimSpace(req.ResourceID); resourceID != "" {
		if _, err := s.repo.ResourceForUser(userID, resourceID); err != nil {
			return model.WorkflowStepInstance{}, err
		}
	}
	metadata := strings.TrimSpace(req.MetadataJSON)
	if metadata == "" {
		metadata = "{}"
	}
	if !json.Valid([]byte(metadata)) {
		return model.WorkflowStepInstance{}, kernel.BadAuthRequest("产物元数据必须是有效 JSON")
	}
	now := time.Now()
	outputJSON := strings.TrimSpace(req.OutputJSON)
	if outputJSON == "" {
		outputJSON = task.ResultJSON
	}
	if strings.TrimSpace(outputJSON) == "" {
		outputJSON = "{}"
	}
	var representation *model.AssetRepresentation
	if strings.TrimSpace(req.AssetVersionID) != "" {
		role := strings.TrimSpace(req.Role)
		if role == "" {
			role = "output"
		}
		if !validShotAssetRole(role) {
			return model.WorkflowStepInstance{}, kernel.BadAuthRequest("不支持的产物用途")
		}
		representation = &model.AssetRepresentation{ID: kernel.NewID(), TaskID: task.ID, AssetVersionID: strings.TrimSpace(req.AssetVersionID), ResourceID: strings.TrimSpace(req.ResourceID), MediaType: strings.TrimSpace(req.MediaType), Role: role, MetadataJSON: metadata, CreatedAt: now}
	}
	link := &model.WorkflowStepTask{ID: kernel.NewID(), WorkflowStepID: step.ID, TaskID: task.ID, CreatedAt: now}
	artifactType := strings.TrimSpace(req.ArtifactType)
	if artifactType == "" && shotID != "" && strings.TrimSpace(req.ResourceID) != "" {
		artifactType = workflowArtifactType(step.StepKey)
	}
	productionLink := &model.ProductionTaskLink{ID: kernel.NewID(), TaskID: task.ID, ProjectID: projectID, CanvasID: canvasID, UnitID: unitID, ShotID: shotID, WorkflowStepID: step.ID, ArtifactType: artifactType, CreatedAt: now, UpdatedAt: now}
	resourceID := strings.TrimSpace(req.ResourceID)
	stored, err := s.repo.RegisterWorkflowTaskOutputActive(userID, projectID, step.ID, shotID, shotRevisionID, unitID, repository.WorkflowTaskOutputRecords{
		Link: link, Representation: representation, ProductionLink: productionLink,
	}, func(current repository.WorkflowOutputCurrent) (repository.WorkflowOutputPlan, error) {
		return planRegisteredTaskOutput(now, task.ID, outputJSON, metadata, resourceID, artifactType, shotRevisionID, current)
	})
	if err != nil {
		return model.WorkflowStepInstance{}, mapProjectWriteError(err)
	}
	return stored, nil
}

func planRegisteredTaskOutput(now time.Time, taskID, outputJSON, metadata, resourceID, artifactType, shotRevisionID string, current repository.WorkflowOutputCurrent) (repository.WorkflowOutputPlan, error) {
	if current.ExistingLink != nil {
		return repository.WorkflowOutputPlan{}, nil
	}
	if current.Step.Status == model.WorkflowStepStatusFailed {
		return repository.WorkflowOutputPlan{}, kernel.BadAuthRequest("失败步骤不能登记成功产物")
	}
	plan := repository.WorkflowOutputPlan{}
	if current.Shot != nil && resourceID != "" && artifactType != "" {
		selected := strings.TrimSpace(shotRevisionID) == current.Shot.CurrentRevisionID
		status := "ready"
		if !selected {
			status = "stale"
		}
		if strings.TrimSpace(metadata) == "" {
			metadata = "{}"
		}
		plan.Artifact = &model.ShotArtifact{
			ID: kernel.NewID(), ProjectID: current.Shot.ProjectID, UnitID: current.Shot.UnitID, ShotID: current.Shot.ID,
			RevisionID: shotRevisionID, TaskID: taskID, Type: artifactType, ResourceID: resourceID,
			Status: status, Selected: selected, MetadataJSON: metadata, CreatedAt: now, UpdatedAt: now,
		}
	}
	step := current.Step
	instance := current.Instance
	if strings.TrimSpace(outputJSON) == "" {
		outputJSON = "{}"
	}
	if current.Shot != nil {
		switch step.Status {
		case model.WorkflowStepStatusPending, model.WorkflowStepStatusReady, model.WorkflowStepStatusRunning:
			if step.Status != model.WorkflowStepStatusRunning {
				step.Status = model.WorkflowStepStatusRunning
			}
			if step.StartedAt == nil {
				started := now
				step.StartedAt = &started
			}
			step.OutputJSON = outputJSON
			step.Error = ""
			step.CompletedAt = nil
			step.UpdatedAt = now
			instance.Revision++
			instance.Status = model.WorkflowStatusActive
			instance.UpdatedAt = now
			plan.Step = &step
			plan.Instance = &instance
		}
		return plan, nil
	}
	if step.Status == model.WorkflowStepStatusCompleted {
		return plan, nil
	}
	if step.Status == model.WorkflowStepStatusFailed || step.Status == model.WorkflowStepStatusSkipped {
		return repository.WorkflowOutputPlan{}, kernel.BadAuthRequest("当前工作流步骤不能登记成功产物")
	}
	step.Status = model.WorkflowStepStatusCompleted
	step.OutputJSON = outputJSON
	step.Error = ""
	completed := now
	step.CompletedAt = &completed
	step.UpdatedAt = now
	if step.StartedAt == nil {
		started := now
		step.StartedAt = &started
	}
	instance.Revision++
	instance.Status = model.WorkflowStatusActive
	instance.UpdatedAt = now
	if current.Next == nil {
		instance.Status = model.WorkflowStatusCompleted
	} else if current.Next.Status == model.WorkflowStepStatusPending {
		next := *current.Next
		next.Status = model.WorkflowStepStatusReady
		next.UpdatedAt = now
		plan.Next = &next
	}
	plan.Step = &step
	plan.Instance = &instance
	return plan, nil
}

func (s *Service) validateWorkflowStepCompletion(projectID string, instance *model.WorkflowInstance, step *model.WorkflowStepInstance) error {
	if instance == nil || strings.TrimSpace(instance.UnitID) == "" {
		return nil
	}
	unit, err := s.repo.ProjectUnit(projectID, instance.UnitID)
	if err != nil {
		return err
	}
	var candidates []model.ProjectAssetCandidate
	var shots []model.Shot
	var artifacts []model.ShotArtifact
	switch step.StepKey {
	case "assets":
		candidates, err = s.repo.ProjectAssetCandidates(projectID)
		if err != nil {
			return err
		}
	case "storyboard", "previz", "video", "delivery":
		shots, err = s.repo.ProjectShots(projectID)
		if err != nil {
			return err
		}
		if step.StepKey != "storyboard" {
			artifacts, err = s.repo.ProjectShotArtifacts(projectID)
			if err != nil {
				return err
			}
		}
	}
	return completionGateAllows(instance, step, unit, candidates, shots, artifacts)
}

func completionGateAllows(instance *model.WorkflowInstance, step *model.WorkflowStepInstance, unit *model.ProjectUnit, candidates []model.ProjectAssetCandidate, shots []model.Shot, artifacts []model.ShotArtifact) error {
	if instance == nil || strings.TrimSpace(instance.UnitID) == "" {
		return nil
	}
	if unit == nil {
		return kernel.BadAuthRequest("章节不存在，不能完成本阶段")
	}
	switch step.StepKey {
	case "story":
		if strings.TrimSpace(unit.SourceText) == "" {
			return kernel.BadAuthRequest("章节正文为空，不能完成剧情阶段")
		}
	case "assets":
		for _, candidate := range candidates {
			if candidate.UnitID == instance.UnitID && candidate.Status == "pending_confirmation" {
				return kernel.BadAuthRequest("仍有待确认资产，不能完成资产拆分阶段")
			}
		}
	case "storyboard", "previz", "video", "delivery":
		unitShots := make([]model.Shot, 0, len(shots))
		for _, shot := range shots {
			if shot.UnitID == instance.UnitID {
				unitShots = append(unitShots, shot)
			}
		}
		if len(unitShots) == 0 {
			return kernel.BadAuthRequest("当前章节还没有分镜，不能完成本阶段")
		}
		if step.StepKey == "storyboard" {
			for _, shot := range unitShots {
				if strings.TrimSpace(shot.CurrentRevisionID) == "" {
					return kernel.BadAuthRequest("存在没有分镜版本的镜头，不能完成分镜阶段")
				}
			}
			return nil
		}
		artifactType := "action_board"
		if step.StepKey == "video" || step.StepKey == "delivery" {
			artifactType = "video"
		}
		shotsByID := make(map[string]model.Shot, len(unitShots))
		for _, shot := range unitShots {
			shotsByID[shot.ID] = shot
		}
		readyShots := make(map[string]struct{}, len(unitShots))
		for _, artifact := range artifacts {
			shot, ok := shotsByID[artifact.ShotID]
			if !ok {
				continue
			}
			if artifact.UnitID == instance.UnitID && artifact.Type == artifactType && artifact.Selected && artifact.Status == "ready" && artifact.RevisionID == shot.CurrentRevisionID {
				readyShots[artifact.ShotID] = struct{}{}
			}
		}
		if len(readyShots) != len(unitShots) {
			if artifactType == "action_board" {
				return kernel.BadAuthRequest("仍有镜头缺少已通过的动作预演，不能完成本阶段")
			}
			return kernel.BadAuthRequest("仍有镜头缺少可交付视频，不能完成本阶段")
		}
	}
	return nil
}

func workflowArtifactType(stepKey string) string {
	switch strings.TrimSpace(stepKey) {
	case "storyboard":
		return "storyboard"
	case "previz":
		return "action_board"
	case "video":
		return "video"
	case "delivery":
		return "delivery"
	default:
		return ""
	}
}

func (s *Service) EnsureGeneratedProjectAsset(userID, projectID, taskID, shotID, resourceID, mediaType, prompt string) (string, error) {
	if _, err := s.Active(userID, projectID); err != nil {
		return "", err
	}
	representations, err := s.repo.AssetRepresentationsForTask(taskID)
	if err != nil {
		return "", err
	}
	for _, representation := range representations {
		if representation.Role == "output" && representation.ResourceID == resourceID && representation.AssetVersionID != "" {
			return representation.AssetVersionID, nil
		}
	}
	resource, err := s.repo.ResourceForUser(userID, resourceID)
	if err != nil {
		return "", err
	}
	if resource.Status != model.ResourceStatusReady {
		return "", kernel.BadAuthRequest("生成资源尚未就绪，无法登记项目素材")
	}
	shot, err := s.repo.ShotForProject(projectID, shotID)
	if err != nil {
		return "", err
	}
	now := time.Now()
	assetID := GeneratedEntityID("asset", taskID)
	versionID := GeneratedEntityID("version", taskID)
	label := "图片"
	if mediaType == "video" {
		label = "视频"
	}
	title := strings.TrimSpace(shot.Title)
	if title == "" {
		title = "镜头产物"
	}
	title += " · " + label
	width := resource.Width
	height := resource.Height
	if width <= 0 {
		width = 1
	}
	if height <= 0 {
		height = 1
	}
	resourceURL := assets.FileURL(resourceID)
	data := map[string]any{
		"storageKey": "resource:" + resourceID,
		"mimeType":   resource.MimeType,
		"bytes":      resource.Size,
		"width":      width,
		"height":     height,
	}
	if mediaType == "image" {
		data["dataUrl"] = resourceURL
	} else {
		data["url"] = resourceURL
		if resource.DurationMs > 0 {
			data["durationMs"] = resource.DurationMs
		}
	}
	payload, _ := json.Marshal(map[string]any{
		"id": assetID, "kind": mediaType, "category": model.AssetCategoryMaterial, "status": model.AssetVersionStatusConfirmed,
		"primaryVersionId": versionID, "title": title, "coverUrl": resourceURL, "tags": []string{},
		"createdAt": now.UTC().Format(time.RFC3339Nano), "updatedAt": now.UTC().Format(time.RFC3339Nano),
		"data": data, "metadata": map[string]any{"source": "short-drama-workflow", "taskId": taskID, "shotId": shot.ID, "projectIds": []string{projectID}},
	})
	asset := &model.Asset{ID: assetID, UserID: userID, Kind: mediaType, Category: model.AssetCategoryMaterial, Status: model.AssetVersionStatusConfirmed, PrimaryVersionID: versionID, Title: title, PayloadJSON: string(payload), CreatedAt: now, UpdatedAt: now}
	version := &model.AssetVersion{ID: versionID, AssetID: assetID, Version: 1, Status: model.AssetVersionStatusConfirmed, DefinitionJSON: "{}", Prompt: prompt, Note: "工作流生成产物", CreatedAt: now, UpdatedAt: now}
	folderID, err := s.resolveAssetFolderID(projectID, nil)
	if err != nil {
		return "", err
	}
	position, err := s.repo.NextProjectAssetPosition(projectID, folderID)
	if err != nil {
		return "", err
	}
	link := &model.ProjectAssetLink{ID: kernel.NewID(), ProjectID: projectID, AssetID: assetID, FolderID: folderID, Position: position, CreatedAt: now}
	if _, err := s.repo.LinkProjectAsset(asset, version, link); err != nil {
		return "", mapProjectWriteError(err)
	}
	return versionID, nil
}

// GeneratedEntityID reuses the same varchar(36) identity for workflow output retries.
func GeneratedEntityID(namespace string, taskID string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(namespace) + ":" + strings.TrimSpace(taskID)))
	return hex.EncodeToString(sum[:16])
}

func validWorkflowStepStatus(status model.WorkflowStepStatus) bool {
	switch status {
	case model.WorkflowStepStatusPending, model.WorkflowStepStatusReady, model.WorkflowStepStatusRunning, model.WorkflowStepStatusReview, model.WorkflowStepStatusCompleted, model.WorkflowStepStatusFailed, model.WorkflowStepStatusSkipped:
		return true
	default:
		return false
	}
}

func canTransitionWorkflowStep(current model.WorkflowStepStatus, next model.WorkflowStepStatus) bool {
	if current == next {
		return true
	}
	allowed := map[model.WorkflowStepStatus]map[model.WorkflowStepStatus]bool{
		model.WorkflowStepStatusPending:   {model.WorkflowStepStatusReady: true, model.WorkflowStepStatusSkipped: true},
		model.WorkflowStepStatusReady:     {model.WorkflowStepStatusRunning: true, model.WorkflowStepStatusSkipped: true},
		model.WorkflowStepStatusRunning:   {model.WorkflowStepStatusReview: true, model.WorkflowStepStatusCompleted: true, model.WorkflowStepStatusFailed: true},
		model.WorkflowStepStatusReview:    {model.WorkflowStepStatusRunning: true, model.WorkflowStepStatusCompleted: true, model.WorkflowStepStatusFailed: true},
		model.WorkflowStepStatusFailed:    {model.WorkflowStepStatusReady: true, model.WorkflowStepStatusRunning: true},
		model.WorkflowStepStatusCompleted: {model.WorkflowStepStatusRunning: true},
		model.WorkflowStepStatusSkipped:   {model.WorkflowStepStatusReady: true},
	}
	return allowed[current][next]
}
