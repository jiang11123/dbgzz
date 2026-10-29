package textreplay

import (
	"encoding/json"
	"errors"
	"strings"
	"time"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

// Service owns text increment persistence, archive compaction, retention,
// and cursor reads. Frontend-managed replay tasks stay out of the provider
// worker queue; this type does not dispatch generation.
type Service struct {
	store Store
	deps  Dependencies
	cache replayCache
}

func New(store Store, deps Dependencies) *Service {
	if deps.Now == nil {
		deps.Now = time.Now
	}
	return &Service{store: store, deps: deps}
}

func (s *Service) now() time.Time {
	if s != nil && s.deps.Now != nil {
		return s.deps.Now()
	}
	return time.Now()
}

func (s *Service) log(userID, taskID, level, message, payload string) {
	if s == nil || s.deps.Logger == nil {
		return
	}
	_ = s.deps.Logger.Log(userID, taskID, level, message, payload)
}

func (s *Service) IsRequest(input map[string]any) bool {
	return IsRequest(input)
}

func (s *Service) Append(userID, taskID, content string) (*model.TaskTextDelta, error) {
	if s == nil || s.store == nil {
		return nil, errors.New("text replay store is not initialized")
	}
	task, err := s.store.TaskForUser(userID, taskID)
	if err != nil {
		return nil, err
	}
	if !textTask(task.Type) {
		return nil, kernel.BadAuthRequest("只有文本生成任务支持增量回放")
	}
	if strings.TrimSpace(content) == "" {
		return nil, kernel.BadAuthRequest("文本增量不能为空")
	}
	if len([]byte(content)) > MaxEventBytes {
		return nil, kernel.BadAuthRequest("单条文本增量不能超过 64KB")
	}
	item, err := s.store.AppendDelta(userID, taskID, content, s.now().Add(DraftRetention), defaultLimits())
	if errors.Is(err, repository.ErrTextReplayQuotaExceeded) {
		return nil, kernel.BadAuthRequest("文本回放增量已达到配额，请等待任务归并后继续")
	}
	if errors.Is(err, repository.ErrTextReplayClosed) {
		return nil, kernel.BadAuthRequest("已结束任务不能继续写入文本增量")
	}
	return item, err
}

func (s *Service) Read(userID, taskID string, after int64) (*Result, error) {
	if s == nil || s.store == nil {
		return nil, errors.New("text replay store is not initialized")
	}
	task, err := s.store.TaskForUser(userID, taskID)
	if err != nil {
		return nil, err
	}
	deltas, err := s.store.Deltas(userID, taskID, after, DeltaPageLimit)
	if err != nil {
		return nil, err
	}
	result := &Result{
		Deltas:    deltas,
		TextDraft: task.TextDraft,
		Complete:  terminalStatus(task.Status),
		Status:    task.Status,
		Stage:     task.Stage,
		Progress:  task.Progress,
		Error:     task.Error,
	}
	if task.Status == model.TaskStatusSucceeded {
		result.FinalText = taskResultText(task.ResultJSON)
	}
	return result, nil
}

func (s *Service) Complete(userID, taskID, text string) (*model.Task, error) {
	if s == nil || s.store == nil {
		return nil, errors.New("text replay store is not initialized")
	}
	if strings.TrimSpace(text) == "" {
		return nil, kernel.BadAuthRequest("文本内容不能为空")
	}
	if len([]byte(text)) > MaxTaskBytes {
		return nil, kernel.BadAuthRequest("文本内容过大")
	}
	if _, err := s.store.TaskForUser(userID, taskID); err != nil {
		return nil, err
	}
	resultJSON, _ := json.Marshal(map[string]any{"mode": "text", "text": text})
	completed, err := s.store.Complete(userID, taskID, string(resultJSON), s.now())
	if err != nil {
		return nil, err
	}
	if !completed {
		return nil, kernel.BadAuthRequest("该文本任务已结束或不属于你，无法完成")
	}
	if compactErr := s.Finalize(taskID, model.TaskStatusSucceeded); compactErr != nil {
		s.log(userID, taskID, "error", "文本回放窗口更新失败", compactErr.Error())
	}
	return s.store.TaskForUser(userID, taskID)
}

func (s *Service) Finalize(taskID string, status model.TaskStatus) error {
	if s == nil || s.store == nil {
		return errors.New("text replay store is not initialized")
	}
	keepDraft := status == model.TaskStatusFailed || status == model.TaskStatusCancelled
	retention := SuccessRetention
	if keepDraft {
		retention = DraftRetention
	}
	err := s.store.Compact(taskID, s.now().Add(retention), keepDraft)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	return err
}

func (s *Service) Sweep() (int64, error) {
	if s == nil || s.store == nil {
		return 0, errors.New("text replay store is not initialized")
	}
	return s.store.Sweep(s.now())
}

func (s *Service) Stats() (Stats, error) {
	if s == nil || s.store == nil {
		return Stats{}, errors.New("text replay store is not initialized")
	}
	return s.store.Stats()
}

func taskResultText(raw string) string {
	var result struct {
		Text string `json:"text"`
	}
	if json.Unmarshal([]byte(raw), &result) != nil {
		return ""
	}
	return result.Text
}
