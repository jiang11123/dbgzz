package project

import (
	"errors"
	"strings"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
	localtask "infinite-canvas/backend/internal/task"
)

type CanvasProductionContext struct {
	ProjectID         string `json:"projectId"`
	CanvasID          string `json:"canvasId"`
	UnitID            string `json:"unitId"`
	ShotID            string `json:"shotId"`
	ShotRevisionID    string `json:"shotRevisionId"`
	StepKey           string `json:"stepKey"`
	WorkflowStepID    string `json:"workflowStepId"`
	ArtifactType      string `json:"artifactType"`
	Linked            bool   `json:"linked"`
	WorkflowAvailable bool   `json:"workflowAvailable"`
}

type CanvasProductionTaskRequest struct {
	UnitID         string `json:"unitId"`
	ShotID         string `json:"shotId"`
	ShotRevisionID string `json:"shotRevisionId"`
	StepKey        string `json:"stepKey"`
	TaskID         string `json:"taskId"`
	ResourceID     string `json:"resourceId,omitempty"`
}

type CanvasProductionTaskResult struct {
	Context    CanvasProductionContext    `json:"context"`
	Step       model.WorkflowStepInstance `json:"step"`
	TaskID     string                     `json:"taskId"`
	ResourceID string                     `json:"resourceId"`
}

func productionError(reason, message string) error {
	return &kernel.AppError{Status: 409, Code: 409, Reason: kernel.ErrorReason(reason), Message: message}
}

// Reading a proposed association never creates workflow rows or moves a canvas.
func (s *Service) CanvasProductionContext(userID, projectID, canvasID, unitID, shotID, stepKey string) (CanvasProductionContext, error) {
	if strings.TrimSpace(unitID) == "" {
		return CanvasProductionContext{}, kernel.BadAuthRequest("请选择制作章节")
	}
	if _, err := s.Active(userID, projectID); err != nil {
		return CanvasProductionContext{}, err
	}
	canvas, err := s.repo.CanvasProjectForUser(userID, strings.TrimSpace(canvasID))
	if err != nil {
		return CanvasProductionContext{}, err
	}
	if canvas.ProjectID != "" && canvas.ProjectID != projectID {
		return CanvasProductionContext{}, productionError("production_canvas_project_conflict", "画布已经属于其他项目，请先明确调整归属")
	}
	shot, err := s.repo.ShotForProject(projectID, strings.TrimSpace(shotID))
	if err != nil {
		return CanvasProductionContext{}, err
	}
	if shot.UnitID != strings.TrimSpace(unitID) || shot.CurrentRevisionID == "" {
		return CanvasProductionContext{}, kernel.BadAuthRequest("镜头不属于所选章节或没有可用版本")
	}
	artifact := workflowArtifactType(stepKey)
	if artifact == "" {
		return CanvasProductionContext{}, kernel.BadAuthRequest("请选择分镜、预演、视频或交付阶段")
	}
	result := CanvasProductionContext{ProjectID: projectID, CanvasID: canvas.ID, UnitID: shot.UnitID, ShotID: shot.ID, ShotRevisionID: shot.CurrentRevisionID, StepKey: strings.TrimSpace(stepKey), ArtifactType: artifact}
	if _, err := s.repo.CanvasUnitLink(projectID, canvas.ID, shot.UnitID); err == nil {
		result.Linked = true
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return CanvasProductionContext{}, err
	}
	workflows, err := s.workflowDetails(projectID)
	if err != nil {
		return CanvasProductionContext{}, err
	}
	for _, workflow := range workflows {
		if workflow.Instance.UnitID == shot.UnitID && workflow.Instance.Scope == "unit" {
			for _, step := range workflow.Steps {
				if step.StepKey == result.StepKey {
					result.WorkflowAvailable = true
					result.WorkflowStepID = step.ID
					return result, nil
				}
			}
		}
	}
	return result, nil
}

// Attach an already generated, local-ready canvas output to existing production
// records. This operation never creates, retries, downloads or dispatches a task.
func (s *Service) RegisterCanvasProductionTask(userID, projectID, canvasID string, req CanvasProductionTaskRequest) (CanvasProductionTaskResult, error) {
	var result CanvasProductionTaskResult
	err := s.repo.DB().Transaction(func(tx *gorm.DB) error {
		bound := New(repository.New(tx), Dependencies{})
		current, err := bound.CanvasProductionContext(userID, projectID, canvasID, req.UnitID, req.ShotID, req.StepKey)
		if err != nil {
			return err
		}
		if strings.TrimSpace(req.ShotRevisionID) == "" || req.ShotRevisionID != current.ShotRevisionID {
			return productionError("production_revision_conflict", "镜头已变化，请查看当前版本后重新确认关联")
		}
		task, err := bound.repo.TaskForUser(userID, strings.TrimSpace(req.TaskID))
		if err != nil {
			return err
		}
		if task.ProjectID != canvasID {
			return productionError("production_task_canvas_mismatch", "只能关联当前画布的生成任务")
		}
		if task.Status != model.TaskStatusSucceeded {
			return productionError("production_output_not_ready", "原任务尚未完成，请等待原任务结果")
		}
		outputs := localtask.CanonicalOutputs(task.ResultJSON, task.Type)
		resourceID, mediaType := "", ""
		for _, output := range outputs {
			if req.ResourceID != "" && output.ResourceID != req.ResourceID {
				continue
			}
			if req.ResourceID == "" && len(outputs) > 1 {
				return productionError("production_output_selection_required", "这个任务有多个产物，请明确选择要关联的素材")
			}
			resourceID = output.ResourceID
			mediaType = output.MediaType
			break
		}
		if resourceID == "" {
			return productionError("production_output_not_ready", "原任务尚无本地可用素材，请恢复原任务结果后再关联")
		}
		resource, err := bound.repo.ResourceForUser(userID, resourceID)
		if err != nil {
			return err
		}
		if resource.Status != model.ResourceStatusReady {
			return productionError("production_output_not_ready", "素材仍在下载或保存，请等待原素材恢复")
		}
		if resource.Kind != mediaType {
			return productionError("production_output_type_mismatch", "原任务素材的类型校验失败")
		}
		if ((current.StepKey == "storyboard" || current.StepKey == "previz") && mediaType != "image") || ((current.StepKey == "video" || current.StepKey == "delivery") && mediaType != "video") {
			return productionError("production_output_type_mismatch", "所选素材类型与制作阶段不一致")
		}
		links, err := bound.repo.ProductionLinksForTask(task.ID)
		if err != nil {
			return err
		}
		for _, link := range links {
			if link.ProjectID != projectID || link.ShotID != current.ShotID || link.ArtifactType != current.ArtifactType {
				return productionError("production_task_already_linked", "此任务已有其他制作记录，请使用该记录中的素材")
			}
		}
		artifacts, err := bound.repo.ShotArtifactsForTask(task.ID)
		if err != nil {
			return err
		}
		for _, artifact := range artifacts {
			if artifact.ResourceID != resourceID {
				return productionError("production_task_already_linked", "此任务已关联其他产物，请使用已有制作记录")
			}
			if artifact.RevisionID != current.ShotRevisionID {
				return productionError("production_output_revision_mismatch", "此任务已登记在旧镜头版本中，原素材仍保留，请查看已有制作记录")
			}
		}
		if !current.Linked {
			if _, err = bound.LinkCanvasUnit(userID, projectID, LinkCanvasUnitRequest{CanvasID: canvasID, UnitID: current.UnitID, Role: "storyboard"}); err != nil {
				return err
			}
		}
		if !current.WorkflowAvailable {
			if _, err = bound.CreateUnitWorkflow(userID, projectID, current.UnitID); err != nil {
				return err
			}
		}
		current, err = bound.CanvasProductionContext(userID, projectID, canvasID, current.UnitID, current.ShotID, current.StepKey)
		if err != nil {
			return err
		}
		versionID, err := bound.EnsureGeneratedProjectAsset(userID, projectID, task.ID, current.ShotID, resourceID, mediaType, task.Prompt)
		if err != nil {
			return err
		}
		step, err := bound.RegisterTaskOutput(userID, projectID, current.WorkflowStepID, RegisterTaskOutputRequest{TaskID: task.ID, CanvasID: canvasID, UnitID: current.UnitID, ShotID: current.ShotID, ShotRevisionID: current.ShotRevisionID, ArtifactType: current.ArtifactType, ResourceID: resourceID, MediaType: mediaType, AssetVersionID: versionID, Role: "output", MetadataJSON: `{"source":"canvas_explicit_assignment"}`})
		if err != nil {
			return err
		}
		result = CanvasProductionTaskResult{Context: current, Step: step, TaskID: task.ID, ResourceID: resourceID}
		return nil
	})
	return result, err
}
