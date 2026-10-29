package app

import (
	"encoding/json"
	"errors"
	"strings"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	localasset "infinite-canvas/backend/internal/asset"
	cw "infinite-canvas/backend/internal/canvasworkflow"
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
)

func workflowBad(message string) error { return kernel.BadAuthRequest(message) }

func workflowNotFound() error {
	return kernel.NewAppError(kernel.CodeNotFound, "工作流或运行记录不存在")
}

func workflowTemplate(row model.CanvasWorkflow) (cw.Template, error) {
	v := cw.Template{ID: row.ID, Name: row.Name, Description: row.Description, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}
	v.Revision = workflowRevision(row.Revision)
	err := json.Unmarshal([]byte(row.DefinitionJSON), &v.Definition)
	return v, err
}

func workflowRun(row model.CanvasWorkflowRun) (cw.Run, error) {
	var v cw.Run
	err := json.Unmarshal([]byte(row.StateJSON), &v)
	if v.Steps == nil {
		v.Steps = []cw.Step{}
	}
	if v.Outputs == nil {
		v.Outputs = []cw.Output{}
	}
	v.ID = row.ID
	v.TemplateID = row.TemplateID
	v.TemplateRevision = workflowRevision(row.TemplateRevision)
	v.TemplateName = row.TemplateName
	v.Status = row.Status
	v.CreatedAt = row.CreatedAt
	v.UpdatedAt = row.UpdatedAt
	return v, err
}

func (s *Service) CanvasWorkflows(user string) ([]cw.Template, error) {
	var rows []model.CanvasWorkflow
	if err := s.repo.DB().Where("user_id = ?", user).Order("created_at DESC").Find(&rows).Error; err != nil {
		return nil, err
	}
	out := []cw.Template{}
	for _, r := range rows {
		v, e := workflowTemplate(r)
		if e != nil {
			return nil, e
		}
		out = append(out, v)
	}
	return out, nil
}

func (s *Service) CanvasWorkflow(user, id string) (cw.Template, error) {
	var row model.CanvasWorkflow
	if err := s.repo.DB().Where("user_id = ? AND id = ?", user, id).First(&row).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return cw.Template{}, workflowNotFound()
		}
		return cw.Template{}, err
	}
	return workflowTemplate(row)
}

func (s *Service) workflowResource(user, id, kind string) (*model.Resource, error) {
	r, e := s.repo.ResourceForUser(user, id)
	if e != nil || r == nil || r.Status != model.ResourceStatusReady {
		return nil, workflowBad("工作流素材不存在或尚未保存，请先保存素材")
	}
	if kind != "" && localasset.NormalizeKind(r.Kind, r.MimeType) != kind {
		return nil, workflowBad("工作流素材类型与节点不一致")
	}
	return r, nil
}

func workflowReferenceRows(owner, user string, refs map[string]bool) []model.CanvasWorkflowResource {
	rows := []model.CanvasWorkflowResource{}
	for id := range refs {
		rows = append(rows, model.CanvasWorkflowResource{OwnerID: owner, UserID: user, ResourceID: id})
	}
	return rows
}

func persistWorkflowReferences(tx *gorm.DB, rows []model.CanvasWorkflowResource) error {
	if len(rows) == 0 {
		return nil
	}
	for _, row := range rows {
		var count int64
		if e := tx.Model(&model.Resource{}).Where("id = ? AND user_id = ? AND status = ?", row.ResourceID, row.UserID, model.ResourceStatusReady).Count(&count).Error; e != nil {
			return e
		}
		if count != 1 {
			return workflowBad("工作流素材已被移除，请重新保存素材")
		}
	}
	return tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&rows).Error
}

func (s *Service) CreateCanvasWorkflow(user string, req cw.CreateRequest) (cw.Template, error) {
	s.canvasWorkflowMu.Lock()
	defer s.canvasWorkflowMu.Unlock()
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" || len([]rune(req.Name)) > 100 || len(req.Description) > 4000 {
		return cw.Template{}, workflowBad("请输入 1–100 字的工作流名称，说明不超过 4000 字节")
	}
	recipes, refs, e := s.compileCanvasWorkflow(user, req.Definition)
	if e != nil {
		return cw.Template{}, e
	}
	raw, e := json.Marshal(recipes)
	if e != nil {
		return cw.Template{}, e
	}
	cipher, e := s.encryptSettingSecret(string(raw))
	if e != nil {
		return cw.Template{}, e
	}
	if req.Definition.PresentationVersion > 0 {
		req.Definition = workflowEditorDefinition(req.Definition, recipes)
	}
	definition, e := json.Marshal(req.Definition)
	if e != nil {
		return cw.Template{}, e
	}
	row := model.CanvasWorkflow{ID: newID(), Revision: 1, UserID: user, Name: req.Name, Description: req.Description, DefinitionJSON: string(definition), RecipeCipher: cipher}
	e = s.repo.DB().Transaction(func(tx *gorm.DB) error {
		if e := tx.Create(&row).Error; e != nil {
			return e
		}
		if e := tx.Create(workflowSnapshot(row)).Error; e != nil {
			return e
		}
		rows := workflowReferenceRows(row.ID, user, refs)
		return persistWorkflowReferences(tx, rows)
	})
	if e != nil {
		return cw.Template{}, e
	}
	return workflowTemplate(row)
}

func (s *Service) DeleteCanvasWorkflow(user, id string) error {
	s.canvasWorkflowMu.Lock()
	defer s.canvasWorkflowMu.Unlock()
	return s.repo.DB().Transaction(func(tx *gorm.DB) error {
		var row model.CanvasWorkflow
		if e := tx.Where("id = ? AND user_id = ?", id, user).First(&row).Error; e != nil {
			return workflowNotFound()
		}
		if e := tx.Where("owner_id = ? AND user_id = ?", id, user).Delete(&model.CanvasWorkflowResource{}).Error; e != nil {
			return e
		}
		if e := tx.Where("template_id = ? AND user_id = ?", id, user).Delete(&model.CanvasWorkflowRevision{}).Error; e != nil {
			return e
		}
		return tx.Delete(&row).Error
	})
}

func (s *Service) CanvasWorkflowRun(user, id string) (cw.Run, error) {
	var row model.CanvasWorkflowRun
	if e := s.repo.DB().Where("id = ? AND user_id = ?", id, user).First(&row).Error; e != nil {
		if errors.Is(e, gorm.ErrRecordNotFound) {
			return cw.Run{}, workflowNotFound()
		}
		return cw.Run{}, e
	}
	return workflowRun(row)
}

func (s *Service) CanvasWorkflowRuns(user, template string) ([]cw.Run, error) {
	if _, e := s.CanvasWorkflow(user, template); e != nil {
		return nil, e
	}
	var rows []model.CanvasWorkflowRun
	if e := s.repo.DB().Where("user_id = ? AND template_id = ?", user, template).Order("created_at DESC").Limit(100).Find(&rows).Error; e != nil {
		return nil, e
	}
	out := []cw.Run{}
	for _, r := range rows {
		v, e := workflowRun(r)
		if e != nil {
			return nil, e
		}
		out = append(out, v)
	}
	return out, nil
}
