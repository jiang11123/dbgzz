package repository

import (
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"infinite-canvas/backend/internal/model"
)

func (r *Repository) EnsureCloudAgent(run *model.CloudAgentExecution) error {
	return r.db.Clauses(clause.OnConflict{DoNothing: true}).Create(run).Error
}
func (r *Repository) CloudAgent(userID, id string) (*model.CloudAgentExecution, error) {
	var run model.CloudAgentExecution
	err := r.db.First(&run, "id = ? AND user_id = ?", id, userID).Error
	return &run, err
}

func (r *Repository) CloudAgentForActiveTask(userID, taskID string) (*model.CloudAgentExecution, error) {
	var run model.CloudAgentExecution
	err := r.db.Where("user_id = ? AND active_task_id = ? AND status IN ?", userID, taskID, []string{"running", "queued"}).First(&run).Error
	return &run, err
}
func (r *Repository) CloudAgentRoots() ([]model.Task, error) {
	var tasks []model.Task
	err := r.db.Where("operation = ? AND id NOT IN (SELECT id FROM cloud_agent_executions)", "cloud_agent").Order("created_at").Limit(50).Find(&tasks).Error
	return tasks, err
}

// A stable keyset makes waiting rows yield to later runs without changing business timestamps.
func (r *Repository) ActiveCloudAgentsAfter(after string, limit int) ([]model.CloudAgentExecution, error) {
	var runs []model.CloudAgentExecution
	if limit < 1 || limit > 50 {
		limit = 50
	}
	err := r.db.Where("(status IN ? OR cleanup_pending = ?) AND id > ?", []string{"running", "queued"}, true, after).Order("id").Limit(limit).Find(&runs).Error
	return runs, err
}

func (r *Repository) ActiveCloudAgents() ([]model.CloudAgentExecution, error) {
	return r.ActiveCloudAgentsAfter("", 50)
}

// Do not load the transcript, tasks and bills for an unchanged SSE subscription.
func (r *Repository) CloudAgentRevision(userID, id string) (int64, error) {
	var run model.CloudAgentExecution
	err := r.db.Select("id", "revision").Where("id = ? AND user_id = ?", id, userID).First(&run).Error
	return run.Revision, err
}

// Lock before reading: checkpoints, canvas writes and task reservations commit together.
func (r *Repository) MutateCloudAgent(userID, id string, revision int64, fn func(*model.CloudAgentExecution, *Repository) error) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		q := tx.Model(&model.CloudAgentExecution{}).Where("id = ? AND user_id = ? AND revision = ?", id, userID, revision).UpdateColumn("revision", gorm.Expr("revision + 1"))
		if q.Error != nil {
			return q.Error
		}
		if q.RowsAffected != 1 {
			return ErrCreationConflict
		}
		run, err := New(tx).CloudAgent(userID, id)
		if err != nil {
			return err
		}
		if err = fn(run, New(tx)); err != nil {
			return err
		}
		return tx.Save(run).Error
	})
}

func (r *Repository) CreateCloudAgentCanvasMutation(mutation *model.CloudAgentCanvasMutation) error {
	return r.db.Create(mutation).Error
}

func (r *Repository) LatestCloudAgentCanvasMutation(userID, runID string) (*model.CloudAgentCanvasMutation, error) {
	var mutation model.CloudAgentCanvasMutation
	err := r.db.Where("user_id = ? AND run_id = ?", userID, runID).
		Order("created_at DESC, id DESC").First(&mutation).Error
	return &mutation, err
}

func (r *Repository) MarkCloudAgentCanvasMutationUndone(userID, runID, mutationID string, undoneAt time.Time) error {
	result := r.db.Model(&model.CloudAgentCanvasMutation{}).
		Where("id = ? AND user_id = ? AND run_id = ? AND status = ?", mutationID, userID, runID, "applied").
		Updates(map[string]any{"status": "undone", "undone_at": undoneAt})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrCreationConflict
	}
	return nil
}

// MarkCloudAgentFailed is a terminal CAS transition that does not read or
// rewrite StateJSON. It is deliberately usable when a corrupted runtime state
// can no longer be decoded; leaving such a run in running would make the
// scheduler retry it forever.
func (r *Repository) MarkCloudAgentFailed(userID, id string, revision int64, message ...string) error {
	detail := "Agent 运行状态损坏，本轮已停止"
	if len(message) > 0 {
		detail = message[0]
	}
	result := r.db.Model(&model.CloudAgentExecution{}).
		Where("id = ? AND user_id = ? AND revision = ? AND status IN ?", id, userID, revision, []string{"queued", "running"}).
		Updates(map[string]any{"status": "failed", "cleanup_pending": true, "failure_message": detail, "revision": gorm.Expr("revision + 1")})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrCreationConflict
	}
	return nil
}

// MarkCloudAgentCancelled is the corruption-safe cancellation transition. It
// intentionally does not touch StateJSON: cancellation must still stop the
// scheduler when the orchestration blob can no longer be decoded.
func (r *Repository) MarkCloudAgentCancelled(userID, id string, revision int64) error {
	result := r.db.Model(&model.CloudAgentExecution{}).
		Where("id = ? AND user_id = ? AND revision = ? AND status IN ?", id, userID, revision, []string{"queued", "running", "waiting_approval"}).
		Updates(map[string]any{"status": "cancelled", "cleanup_pending": true, "revision": gorm.Expr("revision + 1")})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrCreationConflict
	}
	return nil
}
