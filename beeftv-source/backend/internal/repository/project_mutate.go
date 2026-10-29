package repository

import (
	"errors"
	"slices"
	"sort"
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var ErrProjectRevisionConflict = errors.New("project revision changed")

var ErrExpectedRevisionRequired = errors.New("expected revision required")

var ErrProjectArchived = errors.New("project is archived")

var ErrProjectAssetStillReferenced = errors.New("project asset still referenced")

// WorkflowOutputCurrent is the step/instance/shot snapshot loaded inside the
// registration transaction. Callers must derive transitions from this state.
type WorkflowOutputCurrent struct {
	Step         model.WorkflowStepInstance
	Instance     model.WorkflowInstance
	Next         *model.WorkflowStepInstance
	ExistingLink *model.WorkflowStepTask
	Shot         *model.Shot
}

// WorkflowOutputPlan is the mutation derived from WorkflowOutputCurrent.
// A nil Step means the workflow rows stay untouched.
type WorkflowOutputPlan struct {
	Step     *model.WorkflowStepInstance
	Next     *model.WorkflowStepInstance
	Instance *model.WorkflowInstance
	Artifact *model.ShotArtifact
}

// WorkflowTaskOutputRecords are the identity-keyed rows for a task output.
type WorkflowTaskOutputRecords struct {
	Link           *model.WorkflowStepTask
	Representation *model.AssetRepresentation
	ProductionLink *model.ProductionTaskLink
}

// WorkflowProgressCurrent is the step, instance, next step and completion-gate
// rows loaded inside the progress transaction. Callers must re-authorize from this snapshot.
type WorkflowProgressCurrent struct {
	Step       model.WorkflowStepInstance
	Instance   model.WorkflowInstance
	Next       *model.WorkflowStepInstance
	Unit       *model.ProjectUnit
	Candidates []model.ProjectAssetCandidate
	Shots      []model.Shot
	Artifacts  []model.ShotArtifact
}

// WorkflowProgressPlan is the mutation derived from WorkflowProgressCurrent.
type WorkflowProgressPlan struct {
	Step     *model.WorkflowStepInstance
	Next     *model.WorkflowStepInstance
	Instance *model.WorkflowInstance
}

func (r *Repository) CreateProjectWithWorkflow(project *model.Project, instance *model.WorkflowInstance, steps []model.WorkflowStepInstance) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(project).Error; err != nil {
			return err
		}
		if instance == nil {
			return nil
		}
		if err := tx.Create(instance).Error; err != nil {
			return err
		}
		if len(steps) > 0 {
			if err := tx.Create(&steps).Error; err != nil {
				return err
			}
		}
		now := time.Now()
		if err := bumpProjectRevisionTx(tx, project.ID, now); err != nil {
			return err
		}
		project.Revision++
		project.UpdatedAt = now
		return nil
	})
}

func (r *Repository) CreateProjectFolderChecked(folder *model.ProjectFolder) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		parentID := strings.TrimSpace(folder.ParentID)
		folder.ParentID = parentID
		if parentID != "" {
			var parent model.ProjectFolder
			if err := tx.First(&parent, "id = ? AND user_id = ?", parentID, folder.UserID).Error; err != nil {
				return err
			}
		}
		return tx.Create(folder).Error
	})
}

func (r *Repository) MoveProjectAndBump(userID, projectID, folderID string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		current, err := ownedProjectTx(tx, userID, projectID)
		if err != nil {
			return err
		}
		folderID = strings.TrimSpace(folderID)
		if folderID != "" {
			var folder model.ProjectFolder
			if err := tx.First(&folder, "id = ? AND user_id = ?", folderID, userID).Error; err != nil {
				return err
			}
		}
		now := time.Now()
		result := tx.Model(&model.Project{}).Where("id = ? AND user_id = ? AND revision = ?", projectID, userID, current.Revision).Updates(map[string]any{
			"folder_id":  folderID,
			"revision":   current.Revision + 1,
			"updated_at": now,
		})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrProjectRevisionConflict
		}
		return nil
	})
}

func (r *Repository) UpdateProjectCAS(userID string, expectedRevision int64, project *model.Project) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		current, err := ownedProjectTx(tx, userID, project.ID)
		if err != nil {
			return err
		}
		if current.Revision != expectedRevision {
			return ErrProjectRevisionConflict
		}
		result := tx.Model(&model.Project{}).Where("id = ? AND user_id = ? AND revision = ?", project.ID, userID, expectedRevision).Updates(map[string]any{
			"name": project.Name, "type": project.Type, "aspect_ratio": project.AspectRatio, "source_type": project.SourceType,
			"description": project.Description, "cover_resource_id": project.CoverResourceID,
			"style_preset_id": project.StylePresetID, "style_profile_json": project.StyleProfileJSON,
			"default_image_model": project.DefaultImageModel, "default_video_model": project.DefaultVideoModel,
			"status": project.Status, "revision": expectedRevision + 1, "updated_at": project.UpdatedAt,
		})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrProjectRevisionConflict
		}
		return nil
	})
}

func (r *Repository) CreateProjectUnitAndBump(userID, projectID string, unit *model.ProjectUnit) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if _, err := requireActiveProjectTx(tx, userID, projectID); err != nil {
			return err
		}
		if err := tx.Create(unit).Error; err != nil {
			return err
		}
		return bumpProjectRevisionTx(tx, projectID, time.Now())
	})
}

func (r *Repository) ImportProjectUnitsActive(userID, projectID string, units []model.ProjectUnit) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if _, err := requireActiveProjectTx(tx, userID, projectID); err != nil {
			return err
		}
		if err := tx.CreateInBatches(&units, 100).Error; err != nil {
			return err
		}
		return bumpProjectRevisionTx(tx, projectID, time.Now())
	})
}

func (r *Repository) ReorderProjectUnitsActive(userID, projectID string, unitIDs []string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if _, err := requireActiveProjectTx(tx, userID, projectID); err != nil {
			return err
		}
		now := time.Now()
		for position, unitID := range unitIDs {
			result := tx.Model(&model.ProjectUnit{}).Where("id = ? AND project_id = ?", unitID, projectID).Updates(map[string]any{"position": position, "updated_at": now})
			if result.Error != nil {
				return result.Error
			}
			if result.RowsAffected != 1 {
				return gorm.ErrRecordNotFound
			}
		}
		return bumpProjectRevisionTx(tx, projectID, now)
	})
}

func (r *Repository) UpdateProjectUnitActive(userID string, expectedRevision int64, unit *model.ProjectUnit, invalidateWorkflow bool) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if _, err := requireActiveProjectTx(tx, userID, unit.ProjectID); err != nil {
			return err
		}
		result := tx.Model(&model.ProjectUnit{}).Where("id = ? AND project_id = ?", unit.ID, unit.ProjectID).Updates(map[string]any{
			"parent_id": unit.ParentID, "title": unit.Title, "source_text": unit.SourceText, "word_count": unit.WordCount, "status": unit.Status, "position": unit.Position, "updated_at": unit.UpdatedAt,
		})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return gorm.ErrRecordNotFound
		}
		if invalidateWorkflow {
			if err := tx.Model(&model.ShotArtifact{}).Where("project_id = ? AND unit_id = ? AND status NOT IN ?", unit.ProjectID, unit.ID, []string{"failed", "stale"}).Updates(map[string]any{"status": "stale", "selected": false, "updated_at": unit.UpdatedAt}).Error; err != nil {
				return err
			}
			if err := invalidateUnitWorkflowTx(tx, unit.ProjectID, unit.ID, "story", unit.UpdatedAt); err != nil {
				return err
			}
		}
		return bumpProjectRevisionCASTx(tx, unit.ProjectID, expectedRevision, unit.UpdatedAt)
	})
}

func (r *Repository) DeleteProjectUnitActive(userID, projectID, id string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if _, err := requireActiveProjectTx(tx, userID, projectID); err != nil {
			return err
		}
		if err := tx.Where("project_id = ? AND unit_id = ?", projectID, id).Delete(&model.CanvasUnitLink{}).Error; err != nil {
			return err
		}
		shotIDs := tx.Model(&model.Shot{}).Select("id").Where("project_id = ? AND unit_id = ?", projectID, id)
		if err := tx.Where("project_id = ? AND unit_id = ?", projectID, id).Delete(&model.ProductionTaskLink{}).Error; err != nil {
			return err
		}
		if err := tx.Where("project_id = ? AND unit_id = ?", projectID, id).Delete(&model.ShotArtifact{}).Error; err != nil {
			return err
		}
		if err := tx.Where("shot_id IN (?)", shotIDs).Delete(&model.ShotRevision{}).Error; err != nil {
			return err
		}
		if err := tx.Where("shot_id IN (?)", shotIDs).Delete(&model.ShotAssetReference{}).Error; err != nil {
			return err
		}
		if err := tx.Where("project_id = ? AND unit_id = ?", projectID, id).Delete(&model.Shot{}).Error; err != nil {
			return err
		}
		instanceIDs := tx.Model(&model.WorkflowInstance{}).Select("id").Where("project_id = ? AND unit_id = ?", projectID, id)
		stepIDs := tx.Model(&model.WorkflowStepInstance{}).Select("id").Where("workflow_instance_id IN (?)", instanceIDs)
		if err := tx.Where("workflow_step_id IN (?)", stepIDs).Delete(&model.WorkflowStepTask{}).Error; err != nil {
			return err
		}
		if err := tx.Where("workflow_instance_id IN (?)", instanceIDs).Delete(&model.WorkflowStepInstance{}).Error; err != nil {
			return err
		}
		if err := tx.Where("project_id = ? AND unit_id = ?", projectID, id).Delete(&model.WorkflowInstance{}).Error; err != nil {
			return err
		}
		if err := tx.Where("project_id = ? AND unit_id = ?", projectID, id).Delete(&model.ProjectAssetCandidate{}).Error; err != nil {
			return err
		}
		result := tx.Delete(&model.ProjectUnit{}, "id = ? AND project_id = ?", id, projectID)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return gorm.ErrRecordNotFound
		}
		return bumpProjectRevisionTx(tx, projectID, time.Now())
	})
}

func (r *Repository) DeleteCanvasUnitLinkActive(userID, projectID, canvasID, unitID string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if _, err := requireActiveProjectTx(tx, userID, projectID); err != nil {
			return err
		}
		result := tx.Delete(&model.CanvasUnitLink{}, "project_id = ? AND canvas_id = ? AND unit_id = ?", projectID, canvasID, unitID)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return gorm.ErrRecordNotFound
		}
		return bumpProjectRevisionTx(tx, projectID, time.Now())
	})
}

func (r *Repository) UnassignCanvasFromProjectActive(userID, projectID, canvasID, payloadJSON string, updatedAt time.Time, revision int64) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if _, err := requireActiveProjectTx(tx, userID, projectID); err != nil {
			return err
		}
		if err := tx.Where("project_id = ? AND canvas_id = ?", projectID, canvasID).Delete(&model.CanvasUnitLink{}).Error; err != nil {
			return err
		}
		result := tx.Model(&model.CanvasProject{}).Where("id = ? AND user_id = ? AND project_id = ? AND revision = ?", canvasID, userID, projectID, revision).Updates(map[string]any{
			"project_id": "", "payload_json": payloadJSON, "updated_at": updatedAt, "revision": revision + 1,
		})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrCanvasRevisionConflict
		}
		return bumpProjectRevisionTx(tx, projectID, updatedAt)
	})
}

func (r *Repository) LinkCanvasUnitAtomic(userID, projectID string, canvasRevision int64, payloadJSON string, now time.Time, link *model.CanvasUnitLink) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if _, err := requireActiveProjectTx(tx, userID, projectID); err != nil {
			return err
		}
		var canvas model.CanvasProject
		if err := tx.First(&canvas, "id = ? AND user_id = ?", link.CanvasID, userID).Error; err != nil {
			return err
		}
		if canvas.Revision != canvasRevision {
			return ErrCanvasRevisionConflict
		}
		var unit model.ProjectUnit
		if err := tx.First(&unit, "id = ? AND project_id = ?", link.UnitID, projectID).Error; err != nil {
			return err
		}
		oldProjectID := strings.TrimSpace(canvas.ProjectID)
		if oldProjectID != "" && oldProjectID != projectID {
			if err := tx.Where("project_id = ? AND canvas_id = ?", oldProjectID, canvas.ID).Delete(&model.CanvasUnitLink{}).Error; err != nil {
				return err
			}
			var oldProject model.Project
			err := tx.First(&oldProject, "id = ? AND user_id = ?", oldProjectID, userID).Error
			if err == nil && oldProject.Status != model.ProjectStatusArchived {
				if err := bumpProjectRevisionTx(tx, oldProjectID, now); err != nil {
					return err
				}
			} else if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
				return err
			}
		}
		result := tx.Model(&model.CanvasProject{}).
			Where("id = ? AND user_id = ? AND revision = ?", canvas.ID, userID, canvasRevision).
			Updates(map[string]any{
				"project_id":   projectID,
				"payload_json": payloadJSON,
				"updated_at":   now,
				"revision":     canvasRevision + 1,
			})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrCanvasRevisionConflict
		}
		if err := upsertCanvasUnitLinkTx(tx, link); err != nil {
			return err
		}
		return bumpProjectRevisionTx(tx, projectID, now)
	})
}

func (r *Repository) EnsureWorkflowInstanceAndBump(userID, projectID string, instance *model.WorkflowInstance, steps []model.WorkflowStepInstance) ([]model.WorkflowStepInstance, error) {
	var storedSteps []model.WorkflowStepInstance
	err := r.db.Transaction(func(tx *gorm.DB) error {
		if _, err := requireActiveProjectTx(tx, userID, projectID); err != nil {
			return err
		}
		var existing model.WorkflowInstance
		lookup := tx.Where("project_id = ? AND template_version_id = ?", projectID, instance.TemplateVersionID)
		if strings.TrimSpace(instance.UnitID) == "" {
			lookup = lookup.Where("unit_id = '' OR unit_id IS NULL")
		} else {
			lookup = lookup.Where("unit_id = ?", instance.UnitID)
		}
		err := lookup.First(&existing).Error
		if err == nil {
			*instance = existing
			return tx.Where("workflow_instance_id = ?", existing.ID).Order("position asc").Find(&storedSteps).Error
		}
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		if err := tx.Create(instance).Error; err != nil {
			return err
		}
		if len(steps) > 0 {
			if err := tx.Create(&steps).Error; err != nil {
				return err
			}
		}
		storedSteps = steps
		return bumpProjectRevisionTx(tx, projectID, time.Now())
	})
	return storedSteps, err
}

func (r *Repository) UpdateWorkflowProgressActive(userID, projectID, stepID string, expectedRevision int64, apply func(WorkflowProgressCurrent) (WorkflowProgressPlan, error)) (model.WorkflowStepInstance, error) {
	var stored model.WorkflowStepInstance
	err := r.db.Transaction(func(tx *gorm.DB) error {
		if _, err := requireActiveProjectTx(tx, userID, projectID); err != nil {
			return err
		}
		var step model.WorkflowStepInstance
		if err := tx.Table("workflow_step_instances").Select("workflow_step_instances.*").
			Joins("JOIN workflow_instances ON workflow_instances.id = workflow_step_instances.workflow_instance_id").
			Where("workflow_instances.project_id = ? AND workflow_step_instances.id = ?", projectID, stepID).
			First(&step).Error; err != nil {
			return err
		}
		stored = step
		var instance model.WorkflowInstance
		if err := tx.First(&instance, "id = ? AND project_id = ?", step.WorkflowInstanceID, projectID).Error; err != nil {
			return err
		}
		var next *model.WorkflowStepInstance
		var nextRow model.WorkflowStepInstance
		nextErr := tx.Where("workflow_instance_id = ? AND position > ?", instance.ID, step.Position).Order("position asc").First(&nextRow).Error
		if nextErr == nil {
			nextCopy := nextRow
			next = &nextCopy
		} else if !errors.Is(nextErr, gorm.ErrRecordNotFound) {
			return nextErr
		}
		current := WorkflowProgressCurrent{Step: step, Instance: instance, Next: next}
		if unitID := strings.TrimSpace(instance.UnitID); unitID != "" {
			var unitRow model.ProjectUnit
			if err := tx.First(&unitRow, "id = ? AND project_id = ?", unitID, projectID).Error; err != nil {
				return err
			}
			current.Unit = &unitRow
			if err := tx.Where("project_id = ?", projectID).Find(&current.Candidates).Error; err != nil {
				return err
			}
			if err := tx.Where("project_id = ?", projectID).Order("unit_id asc, position asc").Find(&current.Shots).Error; err != nil {
				return err
			}
			if err := tx.Where("project_id = ?", projectID).Find(&current.Artifacts).Error; err != nil {
				return err
			}
		}
		plan, applyErr := apply(current)
		if applyErr != nil {
			return applyErr
		}
		if plan.Step == nil || plan.Instance == nil {
			return gorm.ErrInvalidData
		}
		if err := persistWorkflowProgressTx(tx, projectID, plan.Step, plan.Next, plan.Instance, instance.Revision); err != nil {
			return err
		}
		stored = *plan.Step
		return bumpProjectRevisionCASTx(tx, projectID, expectedRevision, plan.Step.UpdatedAt)
	})
	return stored, err
}

func (r *Repository) RegisterWorkflowTaskOutputActive(userID, projectID, stepID, shotID, shotRevisionID, unitID string, records WorkflowTaskOutputRecords, apply func(WorkflowOutputCurrent) (WorkflowOutputPlan, error)) (model.WorkflowStepInstance, error) {
	var stored model.WorkflowStepInstance
	var err error
	for attempt := 0; attempt < 8; attempt++ {
		err = r.db.Transaction(func(tx *gorm.DB) error {
			if _, err := requireActiveProjectTx(tx, userID, projectID); err != nil {
				return err
			}
			var step model.WorkflowStepInstance
			if err := tx.Table("workflow_step_instances").Select("workflow_step_instances.*").
				Joins("JOIN workflow_instances ON workflow_instances.id = workflow_step_instances.workflow_instance_id").
				Where("workflow_instances.project_id = ? AND workflow_step_instances.id = ?", projectID, stepID).
				First(&step).Error; err != nil {
				return err
			}
			stored = step
			var instance model.WorkflowInstance
			if err := tx.First(&instance, "id = ? AND project_id = ?", step.WorkflowInstanceID, projectID).Error; err != nil {
				return err
			}
			var next *model.WorkflowStepInstance
			var nextRow model.WorkflowStepInstance
			nextErr := tx.Where("workflow_instance_id = ? AND position > ?", instance.ID, step.Position).Order("position asc").First(&nextRow).Error
			if nextErr == nil {
				nextCopy := nextRow
				next = &nextCopy
			} else if !errors.Is(nextErr, gorm.ErrRecordNotFound) {
				return nextErr
			}
			if records.Link == nil {
				return gorm.ErrInvalidData
			}
			var existingLink *model.WorkflowStepTask
			var linkRow model.WorkflowStepTask
			linkErr := tx.Where("workflow_step_id = ? AND task_id = ?", step.ID, records.Link.TaskID).First(&linkRow).Error
			if linkErr == nil {
				existingCopy := linkRow
				existingLink = &existingCopy
			} else if !errors.Is(linkErr, gorm.ErrRecordNotFound) {
				return linkErr
			}
			if strings.TrimSpace(unitID) != "" {
				if err := requireProjectUnitTx(tx, projectID, unitID); err != nil {
					return err
				}
			}
			var shot *model.Shot
			if strings.TrimSpace(shotID) != "" {
				var shotRow model.Shot
				if err := tx.First(&shotRow, "id = ? AND project_id = ?", shotID, projectID).Error; err != nil {
					return err
				}
				if strings.TrimSpace(shotRow.UnitID) != "" {
					if err := requireProjectUnitTx(tx, projectID, shotRow.UnitID); err != nil {
						return err
					}
				}
				if strings.TrimSpace(shotRevisionID) != "" {
					if err := tx.First(&model.ShotRevision{}, "id = ? AND shot_id = ?", shotRevisionID, shotRow.ID).Error; err != nil {
						return err
					}
				}
				shot = &shotRow
				if records.ProductionLink != nil {
					records.ProductionLink.UnitID = shotRow.UnitID
					records.ProductionLink.ShotID = shotRow.ID
				}
			}
			plan, applyErr := apply(WorkflowOutputCurrent{Step: step, Instance: instance, Next: next, ExistingLink: existingLink, Shot: shot})
			if applyErr != nil {
				return applyErr
			}
			if existingLink != nil {
				stored = step
				return nil
			}
			if err := persistWorkflowTaskOutputRecordsTx(tx, records, plan.Artifact); err != nil {
				return err
			}
			if plan.Step != nil {
				if plan.Instance == nil {
					return gorm.ErrInvalidData
				}
				if err := persistWorkflowProgressTx(tx, projectID, plan.Step, plan.Next, plan.Instance, instance.Revision); err != nil {
					return err
				}
				stored = *plan.Step
			}
			now := time.Now()
			if plan.Step != nil {
				now = plan.Step.UpdatedAt
			} else if plan.Artifact != nil {
				now = plan.Artifact.UpdatedAt
			}
			return bumpProjectRevisionTx(tx, projectID, now)
		})
		if err == nil || !errors.Is(err, ErrProjectRevisionConflict) {
			return stored, err
		}
	}
	return stored, err
}

func (r *Repository) CreateProjectAssetVersionAndBump(userID, projectID string, asset *model.Asset, version *model.AssetVersion) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if _, err := requireActiveProjectTx(tx, userID, projectID); err != nil {
			return err
		}
		var linked int64
		if err := tx.Model(&model.ProjectAssetLink{}).Where("project_id = ? AND asset_id = ?", projectID, asset.ID).Count(&linked).Error; err != nil {
			return err
		}
		if linked == 0 {
			return gorm.ErrRecordNotFound
		}
		var maxVersion int
		if err := tx.Model(&model.AssetVersion{}).Where("asset_id = ?", asset.ID).Select("COALESCE(MAX(version), 0)").Scan(&maxVersion).Error; err != nil {
			return err
		}
		version.Version = maxVersion + 1
		if err := tx.Create(version).Error; err != nil {
			return err
		}
		asset.PrimaryVersionID = version.ID
		asset.Status = model.AssetVersionStatusDraft
		result := tx.Model(&model.Asset{}).Where("id = ? AND user_id = ?", asset.ID, asset.UserID).Updates(map[string]any{
			"primary_version_id": asset.PrimaryVersionID, "status": asset.Status, "updated_at": asset.UpdatedAt,
		})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return gorm.ErrRecordNotFound
		}
		return bumpProjectRevisionTx(tx, projectID, asset.UpdatedAt)
	})
}

func (r *Repository) UpdateProjectAssetCategoryAndBump(userID, projectID string, expectedRevision int64, asset *model.Asset) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if _, err := requireActiveProjectTx(tx, userID, projectID); err != nil {
			return err
		}
		var linked int64
		if err := tx.Model(&model.ProjectAssetLink{}).Where("project_id = ? AND asset_id = ?", projectID, asset.ID).Count(&linked).Error; err != nil {
			return err
		}
		if linked == 0 {
			return gorm.ErrRecordNotFound
		}
		result := tx.Model(&model.Asset{}).Where("id = ? AND user_id = ?", asset.ID, asset.UserID).Updates(map[string]any{
			"category": asset.Category, "updated_at": asset.UpdatedAt,
		})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return gorm.ErrRecordNotFound
		}
		return bumpProjectRevisionCASTx(tx, projectID, expectedRevision, asset.UpdatedAt)
	})
}

func (r *Repository) MoveProjectAssetActive(userID, projectID, assetID, folderID string, position int) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if _, err := requireActiveProjectTx(tx, userID, projectID); err != nil {
			return err
		}
		if folderID != "" {
			if err := tx.First(&model.ProjectAssetFolder{}, "id = ? AND project_id = ?", folderID, projectID).Error; err != nil {
				return err
			}
		}
		result := tx.Model(&model.ProjectAssetLink{}).
			Where("project_id = ? AND asset_id = ?", projectID, assetID).
			Updates(map[string]any{"folder_id": folderID, "position": position})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return gorm.ErrRecordNotFound
		}
		return bumpProjectRevisionTx(tx, projectID, time.Now())
	})
}

func (r *Repository) UnlinkProjectAssetAndBump(userID, projectID, assetID string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if _, err := requireActiveProjectTx(tx, userID, projectID); err != nil {
			return err
		}
		var references int64
		if err := tx.Table("shot_asset_references").
			Joins("JOIN shots ON shots.id = shot_asset_references.shot_id").
			Joins("JOIN asset_versions ON asset_versions.id = shot_asset_references.asset_version_id").
			Where("shots.project_id = ? AND asset_versions.asset_id = ?", projectID, assetID).
			Count(&references).Error; err != nil {
			return err
		}
		if references > 0 {
			return ErrProjectAssetStillReferenced
		}
		result := tx.Delete(&model.ProjectAssetLink{}, "project_id = ? AND asset_id = ?", projectID, assetID)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return gorm.ErrRecordNotFound
		}
		return bumpProjectRevisionTx(tx, projectID, time.Now())
	})
}

func (r *Repository) CreateProjectAssetCandidatesAndBump(userID, projectID string, candidates []model.ProjectAssetCandidate) ([]model.ProjectAssetCandidate, error) {
	var inserted []model.ProjectAssetCandidate
	err := r.db.Transaction(func(tx *gorm.DB) error {
		created, runErr := createProjectAssetCandidatesAndBumpTx(tx, userID, projectID, candidates)
		inserted = created
		return runErr
	})
	return inserted, err
}

func createProjectAssetCandidatesAndBumpTx(tx *gorm.DB, userID, projectID string, candidates []model.ProjectAssetCandidate) ([]model.ProjectAssetCandidate, error) {
	if _, err := requireActiveProjectTx(tx, userID, projectID); err != nil {
		return nil, err
	}
	inserted := make([]model.ProjectAssetCandidate, 0, len(candidates))
	for index := range candidates {
		result := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&candidates[index])
		if result.Error != nil {
			return nil, result.Error
		}
		if result.RowsAffected == 1 {
			inserted = append(inserted, candidates[index])
		}
	}
	if len(inserted) == 0 {
		return inserted, nil
	}
	return inserted, bumpProjectRevisionTx(tx, projectID, time.Now())
}

func (r *Repository) CreateProjectAssetFolderActive(userID string, folder *model.ProjectAssetFolder) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if _, err := requireActiveProjectTx(tx, userID, folder.ProjectID); err != nil {
			return err
		}
		if folder.ParentID != "" {
			if err := tx.First(&model.ProjectAssetFolder{}, "id = ? AND project_id = ?", folder.ParentID, folder.ProjectID).Error; err != nil {
				return err
			}
		}
		if err := tx.Create(folder).Error; err != nil {
			return err
		}
		return bumpProjectRevisionTx(tx, folder.ProjectID, folder.UpdatedAt)
	})
}

func (r *Repository) UpdateProjectAssetFolderActive(userID string, expectedRevision int64, folder *model.ProjectAssetFolder) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if _, err := requireActiveProjectTx(tx, userID, folder.ProjectID); err != nil {
			return err
		}
		if folder.ParentID != "" {
			if err := tx.First(&model.ProjectAssetFolder{}, "id = ? AND project_id = ?", folder.ParentID, folder.ProjectID).Error; err != nil {
				return err
			}
		}
		result := tx.Model(&model.ProjectAssetFolder{}).
			Where("id = ? AND project_id = ?", folder.ID, folder.ProjectID).
			Updates(map[string]any{"parent_id": folder.ParentID, "name": folder.Name, "name_key": folder.NameKey, "style": folder.Style, "theme": folder.Theme, "position": folder.Position, "updated_at": folder.UpdatedAt})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return gorm.ErrRecordNotFound
		}
		return bumpProjectRevisionCASTx(tx, folder.ProjectID, expectedRevision, folder.UpdatedAt)
	})
}

func (r *Repository) DeleteProjectAssetFolderActive(userID, projectID, folderID string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if _, err := requireActiveProjectTx(tx, userID, projectID); err != nil {
			return err
		}
		var childCount int64
		if err := tx.Model(&model.ProjectAssetFolder{}).Where("project_id = ? AND parent_id = ?", projectID, folderID).Count(&childCount).Error; err != nil {
			return err
		}
		var assetCount int64
		if err := tx.Model(&model.ProjectAssetLink{}).Where("project_id = ? AND folder_id = ?", projectID, folderID).Count(&assetCount).Error; err != nil {
			return err
		}
		if childCount > 0 || assetCount > 0 {
			return ErrProjectAssetFolderNotEmpty
		}
		result := tx.Delete(&model.ProjectAssetFolder{}, "id = ? AND project_id = ?", folderID, projectID)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return gorm.ErrRecordNotFound
		}
		return bumpProjectRevisionTx(tx, projectID, time.Now())
	})
}

func (r *Repository) CreateProjectCharacterActive(userID, projectID string, asset *model.Asset, version *model.AssetVersion, link *model.ProjectAssetLink) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if _, err := requireActiveProjectTx(tx, userID, projectID); err != nil {
			return err
		}
		if strings.TrimSpace(link.FolderID) != "" {
			if err := tx.First(&model.ProjectAssetFolder{}, "id = ? AND project_id = ?", link.FolderID, projectID).Error; err != nil {
				return err
			}
		}
		if err := tx.Create(asset).Error; err != nil {
			return err
		}
		if err := tx.Create(version).Error; err != nil {
			return err
		}
		if err := tx.Create(link).Error; err != nil {
			return err
		}
		return bumpProjectRevisionTx(tx, projectID, asset.UpdatedAt)
	})
}

func (r *Repository) SaveCharacterVersionActive(userID, projectID, expectedPrimaryVersionID string, asset *model.Asset, version *model.AssetVersion, representations []model.AssetRepresentation, voice *model.CharacterVoiceBinding) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if _, err := requireActiveProjectTx(tx, userID, projectID); err != nil {
			return err
		}
		if err := saveCharacterVersionCAS(tx, expectedPrimaryVersionID, asset, version, representations, voice); err != nil {
			return err
		}
		return bumpProjectRevisionTx(tx, projectID, asset.UpdatedAt)
	})
}

func (r *Repository) ConfirmProjectCharacterCandidateActive(userID string, candidate *model.ProjectAssetCandidate, expectedPrimaryVersionID string, asset *model.Asset, version *model.AssetVersion, representations []model.AssetRepresentation, voice *model.CharacterVoiceBinding) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if _, err := requireActiveProjectTx(tx, userID, candidate.ProjectID); err != nil {
			return err
		}
		if err := saveCharacterVersionCAS(tx, expectedPrimaryVersionID, asset, version, representations, voice); err != nil {
			return err
		}
		result := tx.Model(&model.ProjectAssetCandidate{}).
			Where("id = ? AND project_id = ? AND status = ?", candidate.ID, candidate.ProjectID, "pending_confirmation").
			Updates(map[string]any{"status": candidate.Status, "resolved_asset_id": candidate.ResolvedAssetID, "updated_at": candidate.UpdatedAt})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return gorm.ErrInvalidData
		}
		return bumpProjectRevisionTx(tx, candidate.ProjectID, candidate.UpdatedAt)
	})
}

func (r *Repository) ConfirmProjectAssetCandidateActive(userID string, candidate *model.ProjectAssetCandidate, asset *model.Asset, version *model.AssetVersion, link *model.ProjectAssetLink, createAsset bool) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if _, err := requireActiveProjectTx(tx, userID, candidate.ProjectID); err != nil {
			return err
		}
		if strings.TrimSpace(link.FolderID) != "" {
			if err := tx.First(&model.ProjectAssetFolder{}, "id = ? AND project_id = ?", link.FolderID, link.ProjectID).Error; err != nil {
				return err
			}
		}
		if createAsset {
			if err := tx.Create(asset).Error; err != nil {
				return err
			}
			if err := tx.Create(version).Error; err != nil {
				return err
			}
		} else if err := tx.First(&model.Asset{}, "id = ? AND user_id = ?", asset.ID, asset.UserID).Error; err != nil {
			return err
		}
		if err := tx.Where("project_id = ? AND asset_id = ?", link.ProjectID, link.AssetID).FirstOrCreate(link).Error; err != nil {
			return err
		}
		result := tx.Model(&model.ProjectAssetCandidate{}).
			Where("id = ? AND project_id = ? AND status = ?", candidate.ID, candidate.ProjectID, "pending_confirmation").
			Updates(map[string]any{"status": candidate.Status, "resolved_asset_id": candidate.ResolvedAssetID, "updated_at": candidate.UpdatedAt})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return gorm.ErrInvalidData
		}
		return bumpProjectRevisionTx(tx, candidate.ProjectID, candidate.UpdatedAt)
	})
}

func (r *Repository) SaveShotWithRevisionActive(userID string, shot *model.Shot, revision *model.ShotRevision, create bool, expectedCurrentRevisionID string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if _, err := requireActiveProjectTx(tx, userID, shot.ProjectID); err != nil {
			return err
		}
		if strings.TrimSpace(shot.UnitID) != "" {
			if err := requireProjectUnitTx(tx, shot.ProjectID, shot.UnitID); err != nil {
				return err
			}
		}
		if create {
			if err := tx.Create(shot).Error; err != nil {
				return err
			}
		} else {
			query := whereExpectedPointer(tx.Model(&model.Shot{}).Where("id = ? AND project_id = ?", shot.ID, shot.ProjectID), "current_revision_id", expectedCurrentRevisionID)
			result := query.Updates(map[string]any{
				"unit_id": shot.UnitID, "title": shot.Title, "description": shot.Description, "position": shot.Position,
				"duration_ms": shot.DurationMs, "status": shot.Status, "updated_at": shot.UpdatedAt,
			})
			if result.Error != nil {
				return result.Error
			}
			if result.RowsAffected != 1 {
				return ErrProjectRevisionConflict
			}
		}
		var currentVersion int
		if err := tx.Model(&model.ShotRevision{}).Where("shot_id = ?", shot.ID).Select("COALESCE(MAX(version), 0)").Scan(&currentVersion).Error; err != nil {
			return err
		}
		revision.Version = currentVersion + 1
		if err := tx.Create(revision).Error; err != nil {
			return err
		}
		shot.CurrentRevisionID = revision.ID
		if err := tx.Model(&model.Shot{}).Where("id = ? AND project_id = ?", shot.ID, shot.ProjectID).Updates(map[string]any{
			"current_revision_id": revision.ID, "description": shot.Description, "duration_ms": shot.DurationMs,
			"status": shot.Status, "updated_at": shot.UpdatedAt,
		}).Error; err != nil {
			return err
		}
		if !create {
			if err := tx.Model(&model.ShotArtifact{}).Where("shot_id = ? AND status NOT IN ?", shot.ID, []string{"failed", "stale"}).Updates(map[string]any{"status": "stale", "selected": false, "updated_at": shot.UpdatedAt}).Error; err != nil {
				return err
			}
		}
		if err := invalidateUnitWorkflowTx(tx, shot.ProjectID, shot.UnitID, "storyboard", shot.UpdatedAt); err != nil {
			return err
		}
		return bumpProjectRevisionTx(tx, shot.ProjectID, shot.UpdatedAt)
	})
}

func (r *Repository) ReplaceProjectUnitShotsActive(userID, projectID, unitID string, shots []model.Shot, revisions []model.ShotRevision, references []model.ShotAssetReference, expectedShotIDs []string, expectedShotPointers map[string]string, expectedRevision int64) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		return replaceProjectUnitShotsTx(tx, userID, projectID, unitID, shots, revisions, references, expectedShotIDs, expectedShotPointers, expectedRevision)
	})
}

func replaceProjectUnitShotsTx(tx *gorm.DB, userID, projectID, unitID string, shots []model.Shot, revisions []model.ShotRevision, references []model.ShotAssetReference, expectedShotIDs []string, expectedShotPointers map[string]string, expectedRevision int64) error {
	if _, err := requireActiveProjectTx(tx, userID, projectID); err != nil {
		return err
	}
	if err := requireProjectUnitTx(tx, projectID, unitID); err != nil {
		return err
	}
	seenVersions := make(map[string]struct{}, len(references))
	for _, reference := range references {
		versionID := strings.TrimSpace(reference.AssetVersionID)
		if versionID == "" {
			continue
		}
		if _, seen := seenVersions[versionID]; seen {
			continue
		}
		seenVersions[versionID] = struct{}{}
		if err := requireProjectAssetVersionTx(tx, projectID, versionID); err != nil {
			return err
		}
	}
	if err := assertShotExpectationsTx(tx, projectID, unitID, expectedShotIDs, expectedShotPointers); err != nil {
		return err
	}
	shotIDs := tx.Model(&model.Shot{}).Select("id").Where("project_id = ? AND unit_id = ?", projectID, unitID)
	if err := tx.Where("project_id = ? AND unit_id = ?", projectID, unitID).Delete(&model.ShotArtifact{}).Error; err != nil {
		return err
	}
	if err := tx.Where("shot_id IN (?)", shotIDs).Delete(&model.ShotRevision{}).Error; err != nil {
		return err
	}
	if err := tx.Where("shot_id IN (?)", shotIDs).Delete(&model.ShotAssetReference{}).Error; err != nil {
		return err
	}
	if err := tx.Where("project_id = ? AND shot_id IN (?)", projectID, shotIDs).Delete(&model.ProjectAssetCandidate{}).Error; err != nil {
		return err
	}
	if err := tx.Where("project_id = ? AND unit_id = ?", projectID, unitID).Delete(&model.Shot{}).Error; err != nil {
		return err
	}
	if err := tx.Create(&shots).Error; err != nil {
		return err
	}
	if len(revisions) > 0 {
		if err := tx.Create(&revisions).Error; err != nil {
			return err
		}
	}
	if len(references) > 0 {
		if err := tx.Create(&references).Error; err != nil {
			return err
		}
	}
	now := time.Now()
	if err := invalidateUnitWorkflowTx(tx, projectID, unitID, "storyboard", now); err != nil {
		return err
	}
	if expectedRevision <= 0 {
		return ErrExpectedRevisionRequired
	}
	return bumpProjectRevisionCASTx(tx, projectID, expectedRevision, now)
}

func (r *Repository) DeleteProjectShotActive(userID, projectID, shotID string, updatedAt time.Time) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if _, err := requireActiveProjectTx(tx, userID, projectID); err != nil {
			return err
		}
		var shot model.Shot
		if err := tx.First(&shot, "id = ? AND project_id = ?", shotID, projectID).Error; err != nil {
			return err
		}
		if err := tx.Where("project_id = ? AND shot_id = ?", projectID, shotID).Delete(&model.ProductionTaskLink{}).Error; err != nil {
			return err
		}
		if err := tx.Where("project_id = ? AND shot_id = ?", projectID, shotID).Delete(&model.ShotArtifact{}).Error; err != nil {
			return err
		}
		if err := tx.Where("shot_id = ?", shotID).Delete(&model.ShotRevision{}).Error; err != nil {
			return err
		}
		if err := tx.Where("shot_id = ?", shotID).Delete(&model.ShotAssetReference{}).Error; err != nil {
			return err
		}
		if err := tx.Where("project_id = ? AND shot_id = ?", projectID, shotID).Delete(&model.ProjectAssetCandidate{}).Error; err != nil {
			return err
		}
		result := tx.Where("id = ? AND project_id = ?", shotID, projectID).Delete(&model.Shot{})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return gorm.ErrRecordNotFound
		}
		var remaining []model.Shot
		if err := tx.Select("id", "position").Where("project_id = ? AND unit_id = ?", projectID, shot.UnitID).Order("position asc, created_at asc, id asc").Find(&remaining).Error; err != nil {
			return err
		}
		for position, item := range remaining {
			if item.Position == position {
				continue
			}
			if err := tx.Model(&model.Shot{}).Where("id = ? AND project_id = ?", item.ID, projectID).Update("position", position).Error; err != nil {
				return err
			}
		}
		if err := invalidateUnitWorkflowTx(tx, projectID, shot.UnitID, "storyboard", updatedAt); err != nil {
			return err
		}
		return bumpProjectRevisionTx(tx, projectID, updatedAt)
	})
}

func (r *Repository) UpsertShotAssetReferenceActive(userID, projectID string, reference *model.ShotAssetReference, updatedAt time.Time) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if _, err := requireActiveProjectTx(tx, userID, projectID); err != nil {
			return err
		}
		if err := tx.First(&model.Shot{}, "id = ? AND project_id = ?", reference.ShotID, projectID).Error; err != nil {
			return err
		}
		if err := requireProjectAssetVersionTx(tx, projectID, reference.AssetVersionID); err != nil {
			return err
		}
		result := tx.Model(&model.ShotAssetReference{}).Where("shot_id = ? AND asset_version_id = ? AND role = ?", reference.ShotID, reference.AssetVersionID, reference.Role).Updates(map[string]any{"status": reference.Status})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			if err := tx.Create(reference).Error; err != nil {
				return err
			}
		} else {
			var existing model.ShotAssetReference
			if err := tx.First(&existing, "shot_id = ? AND asset_version_id = ? AND role = ?", reference.ShotID, reference.AssetVersionID, reference.Role).Error; err != nil {
				return err
			}
			reference.ID = existing.ID
			reference.CreatedAt = existing.CreatedAt
		}
		if err := tx.Model(&model.ShotArtifact{}).Where("shot_id = ? AND status NOT IN ?", reference.ShotID, []string{"failed", "stale"}).Updates(map[string]any{"status": "stale", "selected": false, "updated_at": updatedAt}).Error; err != nil {
			return err
		}
		var shot model.Shot
		if err := tx.First(&shot, "id = ? AND project_id = ?", reference.ShotID, projectID).Error; err != nil {
			return err
		}
		if err := invalidateUnitWorkflowTx(tx, projectID, shot.UnitID, "storyboard", updatedAt); err != nil {
			return err
		}
		return bumpProjectRevisionTx(tx, projectID, updatedAt)
	})
}

func (r *Repository) DeleteShotAssetReferenceActive(userID, projectID, shotID, referenceID string, updatedAt time.Time) (bool, error) {
	deleted := false
	err := r.db.Transaction(func(tx *gorm.DB) error {
		if _, err := requireActiveProjectTx(tx, userID, projectID); err != nil {
			return err
		}
		result := tx.Where("id = ? AND shot_id = ?", referenceID, shotID).Delete(&model.ShotAssetReference{})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			return nil
		}
		deleted = true
		if err := tx.Model(&model.ShotArtifact{}).Where("shot_id = ? AND status NOT IN ?", shotID, []string{"failed", "stale"}).Updates(map[string]any{"status": "stale", "selected": false, "updated_at": updatedAt}).Error; err != nil {
			return err
		}
		var shot model.Shot
		if err := tx.First(&shot, "id = ? AND project_id = ?", shotID, projectID).Error; err != nil {
			return err
		}
		if err := invalidateUnitWorkflowTx(tx, projectID, shot.UnitID, "storyboard", updatedAt); err != nil {
			return err
		}
		return bumpProjectRevisionTx(tx, projectID, updatedAt)
	})
	return deleted, err
}

func saveCharacterVersionCAS(tx *gorm.DB, expectedPrimaryVersionID string, asset *model.Asset, version *model.AssetVersion, representations []model.AssetRepresentation, voice *model.CharacterVoiceBinding) error {
	if err := tx.Create(version).Error; err != nil {
		return err
	}
	if len(representations) > 0 {
		if err := tx.Create(&representations).Error; err != nil {
			return err
		}
	}
	if voice != nil {
		if err := tx.Create(voice).Error; err != nil {
			return err
		}
	}
	query := whereExpectedPointer(tx.Model(&model.Asset{}).Where("id = ? AND user_id = ?", asset.ID, asset.UserID), "primary_version_id", expectedPrimaryVersionID)
	result := query.Updates(map[string]any{
		"kind": asset.Kind, "category": asset.Category, "status": asset.Status, "primary_version_id": asset.PrimaryVersionID,
		"title": asset.Title, "payload_json": asset.PayloadJSON, "updated_at": asset.UpdatedAt,
	})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrProjectRevisionConflict
	}
	return nil
}

func ownedProjectTx(tx *gorm.DB, userID, projectID string) (*model.Project, error) {
	var project model.Project
	if err := tx.First(&project, "id = ? AND user_id = ?", projectID, userID).Error; err != nil {
		return nil, err
	}
	return &project, nil
}

func requireActiveProjectTx(tx *gorm.DB, userID, projectID string) (*model.Project, error) {
	project, err := ownedProjectTx(tx, userID, projectID)
	if err != nil {
		return nil, err
	}
	if project.Status == model.ProjectStatusArchived {
		return nil, ErrProjectArchived
	}
	return project, nil
}

func requireUnarchivedProjectTx(tx *gorm.DB, projectID string) error {
	var project model.Project
	if err := tx.First(&project, "id = ?", projectID).Error; err != nil {
		return err
	}
	if project.Status == model.ProjectStatusArchived {
		return ErrProjectArchived
	}
	return nil
}

func bumpProjectRevisionTx(tx *gorm.DB, projectID string, now time.Time) error {
	result := tx.Model(&model.Project{}).Where("id = ?", projectID).Updates(map[string]any{
		"revision":   gorm.Expr("revision + 1"),
		"updated_at": now,
	})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return gorm.ErrRecordNotFound
	}
	return nil
}

func bumpProjectRevisionCASTx(tx *gorm.DB, projectID string, expectedRevision int64, now time.Time) error {
	result := tx.Model(&model.Project{}).Where("id = ? AND revision = ?", projectID, expectedRevision).Updates(map[string]any{
		"revision":   expectedRevision + 1,
		"updated_at": now,
	})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrProjectRevisionConflict
	}
	return nil
}

func upsertCanvasUnitLinkTx(tx *gorm.DB, link *model.CanvasUnitLink) error {
	result := tx.Model(&model.CanvasUnitLink{}).Where("project_id = ? AND canvas_id = ? AND unit_id = ?", link.ProjectID, link.CanvasID, link.UnitID).Updates(map[string]any{"role": link.Role})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected > 0 {
		var existing model.CanvasUnitLink
		if err := tx.First(&existing, "project_id = ? AND canvas_id = ? AND unit_id = ?", link.ProjectID, link.CanvasID, link.UnitID).Error; err != nil {
			return err
		}
		link.ID = existing.ID
		link.CreatedAt = existing.CreatedAt
		link.Role = existing.Role
		return nil
	}
	return tx.Create(link).Error
}

func persistWorkflowTaskOutputRecordsTx(tx *gorm.DB, records WorkflowTaskOutputRecords, artifact *model.ShotArtifact) error {
	if records.Link == nil {
		return gorm.ErrInvalidData
	}
	if err := tx.Create(records.Link).Error; err != nil {
		return err
	}
	if records.Representation != nil {
		var existingRepresentation model.AssetRepresentation
		if err := tx.Where("task_id = ? AND role = ?", records.Representation.TaskID, records.Representation.Role).First(&existingRepresentation).Error; errors.Is(err, gorm.ErrRecordNotFound) {
			if err := tx.Create(records.Representation).Error; err != nil {
				return err
			}
		} else if err != nil {
			return err
		}
	}
	if records.ProductionLink != nil {
		var existingProductionLink model.ProductionTaskLink
		err := tx.Where("task_id = ? AND shot_id = ? AND artifact_type = ?", records.ProductionLink.TaskID, records.ProductionLink.ShotID, records.ProductionLink.ArtifactType).First(&existingProductionLink).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			if err := tx.Create(records.ProductionLink).Error; err != nil {
				return err
			}
		} else if err != nil {
			return err
		} else if err := tx.Model(&existingProductionLink).Updates(map[string]any{
			"project_id": records.ProductionLink.ProjectID, "canvas_id": records.ProductionLink.CanvasID, "unit_id": records.ProductionLink.UnitID,
			"workflow_step_id": records.ProductionLink.WorkflowStepID, "updated_at": records.ProductionLink.UpdatedAt,
		}).Error; err != nil {
			return err
		}
	}
	if artifact == nil {
		return nil
	}
	var existing model.ShotArtifact
	if err := tx.Where("task_id = ? AND shot_id = ? AND type = ?", artifact.TaskID, artifact.ShotID, artifact.Type).First(&existing).Error; err == nil {
		return nil
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return err
	}
	var currentVersion int
	if err := tx.Model(&model.ShotArtifact{}).Where("shot_id = ? AND type = ?", artifact.ShotID, artifact.Type).Select("COALESCE(MAX(version), 0)").Scan(&currentVersion).Error; err != nil {
		return err
	}
	artifact.Version = currentVersion + 1
	if artifact.Selected {
		if err := tx.Model(&model.ShotArtifact{}).Where("shot_id = ? AND type = ?", artifact.ShotID, artifact.Type).Updates(map[string]any{"selected": false, "updated_at": artifact.UpdatedAt}).Error; err != nil {
			return err
		}
	}
	return tx.Create(artifact).Error
}

func persistWorkflowProgressTx(tx *gorm.DB, projectID string, step *model.WorkflowStepInstance, next *model.WorkflowStepInstance, instance *model.WorkflowInstance, expectedInstanceRevision int64) error {
	stepResult := tx.Model(&model.WorkflowStepInstance{}).Where("id = ? AND workflow_instance_id = ?", step.ID, step.WorkflowInstanceID).Updates(map[string]any{
		"status": step.Status, "output_json": step.OutputJSON, "error": step.Error, "started_at": step.StartedAt,
		"completed_at": step.CompletedAt, "updated_at": step.UpdatedAt,
	})
	if stepResult.Error != nil {
		return stepResult.Error
	}
	if stepResult.RowsAffected != 1 {
		return gorm.ErrInvalidData
	}
	if next != nil {
		nextResult := tx.Model(&model.WorkflowStepInstance{}).Where("id = ? AND workflow_instance_id = ?", next.ID, next.WorkflowInstanceID).Updates(map[string]any{"status": next.Status, "updated_at": next.UpdatedAt})
		if nextResult.Error != nil {
			return nextResult.Error
		}
		if nextResult.RowsAffected != 1 {
			return gorm.ErrInvalidData
		}
	}
	instanceResult := tx.Model(&model.WorkflowInstance{}).Where("id = ? AND project_id = ? AND revision = ?", instance.ID, projectID, expectedInstanceRevision).Updates(map[string]any{"status": instance.Status, "revision": instance.Revision, "updated_at": instance.UpdatedAt})
	if instanceResult.Error != nil {
		return instanceResult.Error
	}
	if instanceResult.RowsAffected != 1 {
		return ErrProjectRevisionConflict
	}
	return nil
}

func requireProjectUnitTx(tx *gorm.DB, projectID, unitID string) error {
	return tx.First(&model.ProjectUnit{}, "id = ? AND project_id = ?", unitID, projectID).Error
}

func requireProjectAssetVersionTx(tx *gorm.DB, projectID, versionID string) error {
	var version model.AssetVersion
	return tx.Table("asset_versions").Select("asset_versions.id").
		Joins("JOIN project_asset_links ON project_asset_links.asset_id = asset_versions.asset_id").
		Where("project_asset_links.project_id = ? AND asset_versions.id = ?", projectID, versionID).
		First(&version).Error
}

func assertShotExpectationsTx(tx *gorm.DB, projectID, unitID string, expectedShotIDs []string, expectedShotPointers map[string]string) error {
	var current []model.Shot
	if err := tx.Select("id", "current_revision_id").Where("project_id = ? AND unit_id = ?", projectID, unitID).Find(&current).Error; err != nil {
		return err
	}
	if expectedShotIDs != nil {
		currentIDs := make([]string, 0, len(current))
		for _, shot := range current {
			currentIDs = append(currentIDs, shot.ID)
		}
		sort.Strings(currentIDs)
		expected := append([]string(nil), expectedShotIDs...)
		sort.Strings(expected)
		if !slices.Equal(currentIDs, expected) {
			return ErrProjectUnitShotsChanged
		}
	}
	if expectedShotPointers != nil {
		if len(current) != len(expectedShotPointers) {
			return ErrProjectUnitShotsChanged
		}
		for _, shot := range current {
			expected, ok := expectedShotPointers[shot.ID]
			if !ok || expected != shot.CurrentRevisionID {
				return ErrProjectUnitShotsChanged
			}
		}
	}
	return nil
}

func whereExpectedPointer(tx *gorm.DB, column, expected string) *gorm.DB {
	if strings.TrimSpace(expected) == "" {
		return tx.Where("("+column+" IS NULL OR "+column+" = ?)", "")
	}
	return tx.Where(column+" = ?", expected)
}
