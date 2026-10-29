package app

import (
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"infinite-canvas/backend/internal/repository"
)

func pendingStorageKey(userID, identity string) string {
	return strings.TrimSpace(userID) + "\x00" + strings.TrimSpace(identity)
}

func (s *Service) pendingStorageTotal(userID string) int64 {
	prefix := strings.TrimSpace(userID) + "\x00"
	var total int64
	for key, size := range s.pendingStorage {
		if strings.HasPrefix(key, prefix) {
			total += size
		}
	}
	return total
}

// 上传额度在写文件或 OSS 前原子预留，避免并发请求同时通过日限额检查。
func (s *Service) reserveUserUploadQuota(userID string, size int64) (string, error) {
	return s.reserveUserUploadQuotaFor(userID, size, "")
}

func (s *Service) reserveUserUploadQuotaFor(userID string, size int64, identity string) (string, error) {
	policy, err := s.RuntimePolicy()
	if err != nil {
		return "", err
	}
	return s.reserveUserStoredFileQuota(userID, size, megabytes(policy.Resource.ResourceUploadMB), megabytes(policy.Resource.DailyUploadMB), gigabytes(policy.Resource.StoredFileGB), fmt.Sprintf("单个上传文件必须小于 %dMB", policy.Resource.ResourceUploadMB), identity)
}

// reserveChunkedUploadQuota 用于分片上传完成时预留额度：单文件上限对分片会话不适用（每片已独立校验），
// 仅受“今日上传”与“账号存储总量”约束；singleFileLimit 传 size+1 使单文件上限永不命中。
func (s *Service) reserveChunkedUploadQuota(userID string, size int64) (string, error) {
	return s.reserveChunkedUploadQuotaFor(userID, size, "")
}

func (s *Service) reserveChunkedUploadQuotaFor(userID string, size int64, identity string) (string, error) {
	policy, err := s.RuntimePolicy()
	if err != nil {
		return "", err
	}
	return s.reserveUserStoredFileQuota(userID, size, size+1, megabytes(policy.Resource.DailyUploadMB), gigabytes(policy.Resource.StoredFileGB), "", identity)
}

func (s *Service) reserveGeneratedResourceQuota(userID string, size int64) (string, error) {
	return s.reserveGeneratedResourceQuotaFor(userID, size, "")
}

func (s *Service) reserveGeneratedResourceQuotaFor(userID string, size int64, identity string) (string, error) {
	policy, err := s.RuntimePolicy()
	if err != nil {
		return "", err
	}
	return s.reserveUserStoredFileQuota(userID, size, megabytes(policy.Resource.GeneratedFileMB)+1, megabytes(policy.Resource.DailyUploadMB), gigabytes(policy.Resource.StoredFileGB), fmt.Sprintf("单个生成文件不能超过 %dMB", policy.Resource.GeneratedFileMB), identity)
}

// 失败资源的记录已经计入账号存储用量；重试只重新预留当日上传额度，避免重复计算存储容量。
func (s *Service) reserveRetryUploadQuota(userID string, size int64) (string, error) {
	return s.reserveRetryUploadQuotaFor(userID, size, "")
}

func (s *Service) reserveRetryUploadQuotaFor(userID string, size int64, identity string) (string, error) {
	policy, err := s.RuntimePolicy()
	if err != nil {
		return "", err
	}
	if size <= 0 {
		return "", BadAuthRequest("上传文件不能为空")
	}
	if size >= megabytes(policy.Resource.ResourceUploadMB) {
		return "", BadAuthRequest(fmt.Sprintf("单个上传文件必须小于 %dMB", policy.Resource.ResourceUploadMB))
	}
	day := time.Now().UTC().Format("2006-01-02")
	s.storageMu.Lock()
	defer s.storageMu.Unlock()
	if err := s.repo.ReserveIdentifiedDailyUpload(userID, day, identity, size, megabytes(policy.Resource.DailyUploadMB)); err != nil {
		if errors.Is(err, repository.ErrDailyUploadLimitExceeded) {
			return "", QuotaExceeded(fmt.Sprintf("每个账号 UTC 自然日上传总量必须小于 %s", formatStorageLimit(megabytes(policy.Resource.DailyUploadMB))))
		}
		if errors.Is(err, repository.ErrUploadReservationConflict) {
			return "", resourceUploadInProgress()
		}
		return "", err
	}
	return day, nil
}

func (s *Service) reserveRetryGeneratedQuota(userID string, size int64) (string, error) {
	return s.reserveRetryGeneratedQuotaFor(userID, size, "")
}

func (s *Service) reserveRetryGeneratedQuotaFor(userID string, size int64, identity string) (string, error) {
	policy, err := s.RuntimePolicy()
	if err != nil {
		return "", err
	}
	if size <= 0 {
		return "", BadAuthRequest("上传文件不能为空")
	}
	if size >= megabytes(policy.Resource.GeneratedFileMB)+1 {
		return "", BadAuthRequest(fmt.Sprintf("单个生成文件不能超过 %dMB", policy.Resource.GeneratedFileMB))
	}
	day := time.Now().UTC().Format("2006-01-02")
	s.storageMu.Lock()
	defer s.storageMu.Unlock()
	if err := s.repo.ReserveIdentifiedDailyUpload(userID, day, identity, size, megabytes(policy.Resource.DailyUploadMB)); err != nil {
		if errors.Is(err, repository.ErrDailyUploadLimitExceeded) {
			return "", QuotaExceeded(fmt.Sprintf("每个账号 UTC 自然日上传总量必须小于 %s", formatStorageLimit(megabytes(policy.Resource.DailyUploadMB))))
		}
		if errors.Is(err, repository.ErrUploadReservationConflict) {
			return "", resourceUploadInProgress()
		}
		return "", err
	}
	return day, nil
}

func (s *Service) reserveUserStoredFileQuota(userID string, size int64, exclusiveSingleFileLimit int64, dailyLimit int64, storedLimit int64, singleFileMessage string, identity string) (string, error) {
	if size <= 0 {
		return "", BadAuthRequest("上传文件不能为空")
	}
	if size >= exclusiveSingleFileLimit {
		return "", BadAuthRequest(singleFileMessage)
	}
	day := time.Now().UTC().Format("2006-01-02")
	s.storageMu.Lock()
	defer s.storageMu.Unlock()
	storedBytes, err := s.repo.UserStoredFileBytes(userID)
	if err != nil {
		return "", err
	}
	if s.pendingStorage == nil {
		s.pendingStorage = map[string]int64{}
	}
	key := pendingStorageKey(userID, identity)
	if storedBytes+s.pendingStorageTotal(userID)+size >= storedLimit {
		return "", QuotaExceeded(fmt.Sprintf("账号资源和会话附件已达到 %s 上限，请联系管理员清理历史文件", formatStorageLimit(storedLimit)))
	}
	s.pendingStorage[key] += size
	if err := s.repo.ReserveIdentifiedDailyUpload(userID, day, identity, size, dailyLimit); err != nil {
		s.decreasePendingStorage(key, size)
		if errors.Is(err, repository.ErrDailyUploadLimitExceeded) {
			return "", QuotaExceeded(fmt.Sprintf("每个账号 UTC 自然日上传总量必须小于 %s", formatStorageLimit(dailyLimit)))
		}
		if errors.Is(err, repository.ErrUploadReservationConflict) {
			return "", resourceUploadInProgress()
		}
		return "", err
	}
	return day, nil
}

func formatStorageLimit(value int64) string {
	if value%(1<<30) == 0 {
		return fmt.Sprintf("%dGB", value>>30)
	}
	return fmt.Sprintf("%dMB", value>>20)
}

func (s *Service) releaseUserUploadQuota(userID string, day string, size int64) {
	s.releaseUserUploadQuotaFor(userID, day, size, "")
}

func (s *Service) releaseUserUploadQuotaFor(userID string, day string, size int64, identity string) {
	if day == "" || size <= 0 {
		return
	}
	s.storageMu.Lock()
	defer s.storageMu.Unlock()
	if err := s.repo.ReleaseIdentifiedDailyUpload(userID, day, identity, size); err != nil {
		log.Printf("release upload quota failed: user=%s day=%s size=%d error=%v", userID, day, size, err)
		return
	}
	s.decreasePendingStorage(pendingStorageKey(userID, identity), size)
}

func (s *Service) releaseRetryUploadQuota(userID string, day string, size int64) {
	s.releaseRetryUploadQuotaFor(userID, day, size, "")
}

func (s *Service) releaseRetryUploadQuotaFor(userID string, day string, size int64, identity string) {
	if day == "" || size <= 0 {
		return
	}
	s.storageMu.Lock()
	defer s.storageMu.Unlock()
	if err := s.repo.ReleaseIdentifiedDailyUpload(userID, day, identity, size); err != nil {
		log.Printf("release retry upload quota failed: user=%s day=%s size=%d error=%v", userID, day, size, err)
		return
	}
}

func (s *Service) commitUserUploadQuota(userID string, size int64) {
	s.commitUserUploadQuotaFor(userID, size, "")
}

func (s *Service) commitUserUploadQuotaFor(userID string, size int64, identity string) {
	if size <= 0 {
		return
	}
	s.storageMu.Lock()
	defer s.storageMu.Unlock()
	if s.repo != nil {
		if err := s.repo.ClearUploadReservation(userID, identity); err != nil {
			log.Printf("clear upload reservation failed: user=%s identity=%s error=%v", userID, identity, err)
			return
		}
	}
	key := pendingStorageKey(userID, identity)
	if _, ok := s.pendingStorage[key]; ok {
		s.decreasePendingStorage(key, size)
	}
}

func (s *Service) decreasePendingStorage(key string, size int64) {
	remaining := s.pendingStorage[key] - size
	if remaining > 0 {
		s.pendingStorage[key] = remaining
		return
	}
	delete(s.pendingStorage, key)
}
