package app

import (
	"context"
	"fmt"
	"strings"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/playback"
	"infinite-canvas/backend/internal/taskdelivery"
)

func (s *Service) persistTaskGeneratedMediaResult(task model.Task, result map[string]interface{}) (persisted map[string]interface{}, err error) {
	_, finishTrace := s.SupportTrace().Start(taskSupportContext(context.Background(), task), "generation.persist", taskSupportFields(task))
	defer func() { finishTrace(supportFailureReason(err)) }()
	if strings.TrimSpace(task.ID) == "" || strings.TrimSpace(task.UserID) == "" {
		return nil, fmt.Errorf("生成结果缺少任务身份")
	}
	persisted, err = s.generatedMediaIngestor().IngestResult(task.UserID, result, taskdelivery.IngestOptions{
		EnforceQuota: true, IdentityPrefix: task.ID + ":inline",
	})
	if full := kernel.DiskFullError(err); full != nil {
		return nil, full
	}
	return persisted, err
}

func (s *Service) persistGeneratedMediaResult(userID string, result map[string]interface{}) (map[string]interface{}, error) {
	return s.persistGeneratedMediaResultMode(userID, result, false, true)
}

func (s *Service) persistLegacyGeneratedMediaResult(userID string, result map[string]interface{}) (map[string]interface{}, error) {
	return s.persistGeneratedMediaResultMode(userID, result, true, false)
}

func (s *Service) persistGeneratedMediaResultMode(userID string, result map[string]interface{}, skipInvalidDataURL bool, enforceQuota bool) (map[string]interface{}, error) {
	return s.generatedMediaIngestor().IngestResult(userID, result, taskdelivery.IngestOptions{
		SkipInvalidDataURL: skipInvalidDataURL,
		EnforceQuota:       enforceQuota,
	})
}

func (s *Service) persistGeneratedMediaValue(userID string, value interface{}) (interface{}, error) {
	return s.generatedMediaIngestor().Ingest(userID, value, taskdelivery.IngestOptions{EnforceQuota: true})
}

func (s *Service) generatedMediaIngestor() *taskdelivery.Ingestor {
	return taskdelivery.NewIngestor(taskdelivery.IngestDeps{
		Store:      taskdelivery.NewAssetInlineStore(s.resourceDomain()),
		MaxBytes:   s.generatedMediaMaxBytes,
		ProbeVideo: playback.ProbeGeneratedVideoMedia,
	})
}

func (s *Service) generatedMediaMaxBytes() (int64, error) {
	policy, err := s.RuntimePolicy()
	if err != nil {
		return 0, err
	}
	return megabytes(policy.Resource.GeneratedFileMB), nil
}

func (s *Service) decodeDataURL(value string) (string, []byte, error) {
	mimeType, data, err := taskdelivery.DecodeInlineDataURL(value)
	if err != nil {
		return "", nil, err
	}
	limit, err := s.generatedMediaMaxBytes()
	if err != nil {
		return "", nil, err
	}
	if limit > 0 && int64(len(data)) > limit {
		return "", nil, fmt.Errorf("单个生成资源超过 %dMB", limit>>20)
	}
	return mimeType, data, nil
}
