package repository

import (
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"
)

const (
	diagnosticTaskLimit    = 100
	diagnosticTaskLogLimit = 2000
	diagnosticAPICallLimit = 1000
)

func (r *Repository) DiagnosticTasks(userID string, from time.Time, to time.Time, taskID string, projectID string) ([]model.Task, error) {
	var tasks []model.Task
	query := r.db.Model(&model.Task{}).Select(
		"id", "user_id", "trace_id", "request_id", "project_id", "type", "status", "stage", "progress",
		"operation", "provider", "model", "logical_model_id", "provider_request_id", "error", "attempts",
		"client_operation_id", "input_json", "failure_diagnostics",
		"started_at", "completed_at", "created_at", "updated_at",
	)
	if taskID = strings.TrimSpace(taskID); taskID != "" {
		query = query.Where("user_id = ? AND id = ?", userID, taskID)
	} else {
		// SQLite stores timestamps as text in the writer's local offset while the
		// window is UTC, so a raw string comparison silently drops rows. Compare
		// instants instead, and keep a task that is still running/failing inside
		// the window even when it was created before it.
		query = query.Where("user_id = ? AND ((julianday(created_at) >= julianday(?) AND julianday(created_at) <= julianday(?)) OR (julianday(updated_at) >= julianday(?) AND julianday(updated_at) <= julianday(?)))", userID, from, to, from, to)
		if projectID = strings.TrimSpace(projectID); projectID != "" {
			query = query.Where("project_id = ?", projectID)
		}
	}
	// The extra row lets the exporter distinguish a full page from truncation.
	// Prioritize recent activity, including an older task that failed just now.
	err := query.Order("MAX(julianday(created_at), julianday(updated_at)) DESC").Order("id DESC").Limit(diagnosticTaskLimit + 1).Find(&tasks).Error
	return tasks, err
}

func (r *Repository) DiagnosticTaskLogs(userID string, from time.Time, to time.Time, taskID string, projectID string) ([]model.TaskLog, error) {
	var logs []model.TaskLog
	query := r.db.Where("user_id = ?", userID)
	if taskID = strings.TrimSpace(taskID); taskID != "" {
		query = query.Where("task_id = ?", taskID)
	} else {
		query = query.Where("julianday(created_at) >= julianday(?) AND julianday(created_at) <= julianday(?)", from, to)
		if projectID = strings.TrimSpace(projectID); projectID != "" {
			query = query.Where("task_id IN (SELECT id FROM tasks WHERE user_id = ? AND project_id = ?)", userID, projectID)
		}
	}
	err := query.Order("julianday(created_at) DESC").Order("id DESC").Limit(diagnosticTaskLogLimit + 1).Find(&logs).Error
	return logs, err
}

func (r *Repository) DiagnosticAPICallLogs(userID string, from time.Time, to time.Time, taskID string, projectID string) ([]model.ApiCallLog, error) {
	var logs []model.ApiCallLog
	query := r.db.Where("user_id = ?", userID)
	if taskID = strings.TrimSpace(taskID); taskID != "" {
		query = query.Where("task_id = ?", taskID)
	} else {
		query = query.Where("julianday(created_at) >= julianday(?) AND julianday(created_at) <= julianday(?)", from, to)
		if projectID = strings.TrimSpace(projectID); projectID != "" {
			query = query.Where("task_id IN (SELECT id FROM tasks WHERE user_id = ? AND project_id = ?)", userID, projectID)
		}
	}
	err := query.Omit("RequestBody", "ResponseBody").Order("julianday(created_at) DESC").Order("id DESC").Limit(diagnosticAPICallLimit + 1).Find(&logs).Error
	return logs, err
}
