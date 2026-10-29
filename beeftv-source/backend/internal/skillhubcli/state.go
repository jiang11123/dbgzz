package skillhubcli

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"infinite-canvas/backend/internal/privatefile"
	"infinite-canvas/backend/internal/skillhub"
)

type publishingState struct {
	Market       string                     `json:"market"`
	DeviceCode   string                     `json:"deviceCode,omitempty"`
	AccessToken  string                     `json:"accessToken,omitempty"`
	ExpiresAt    int64                      `json:"expiresAt,omitempty"`
	SubmissionID string                     `json:"submissionId,omitempty"`
	CreateKey    string                     `json:"createKey,omitempty"`
	ContentHash  string                     `json:"contentHash,omitempty"`
	MetadataHash string                     `json:"metadataHash,omitempty"`
	Account      skillhub.PublishingAccount `json:"account"`
}

func loadState(name, market string, allowNew bool) (*publishingState, error) {
	if name == "" {
		return nil, fail("state_required", "请通过 --state 指定私有投稿状态文件")
	}
	info, err := os.Lstat(name)
	if os.IsNotExist(err) && allowNew {
		return &publishingState{Market: market}, nil
	}
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() > 1<<20 {
		return nil, fail("unsafe_state_file", "投稿状态文件必须为私有普通文件，权限为0600")
	}
	if err = privatefile.Check(name, info); err != nil {
		return nil, fail("unsafe_state_file", err.Error())
	}
	data, err := os.ReadFile(name)
	if err != nil {
		return nil, err
	}
	var state publishingState
	if err = json.Unmarshal(data, &state); err != nil {
		return nil, fail("invalid_state_file", "投稿状态文件无效")
	}
	if state.Market != market {
		return nil, fail("market_mismatch", "这份授权属于其他市场，请使用对应状态文件")
	}
	if state.SubmissionID != "" && !skillhub.ResourceID.MatchString(state.SubmissionID) {
		return nil, fail("invalid_state_file", "投稿标识无效")
	}
	return &state, nil
}

func lockState(name string) (func(), error) {
	if name == "" {
		return nil, fail("state_required", "请通过 --state 指定私有投稿状态文件")
	}
	if err := os.MkdirAll(filepath.Dir(name), 0700); err != nil {
		return nil, err
	}
	lock, err := os.OpenFile(name+".lock", os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return nil, &Error{Code: 4, Reason: "state_locked", Message: "这份投稿正在被其他进程使用，或遗留状态锁需要检查"}
	}
	lock.Close()
	return func() { _ = os.Remove(name + ".lock") }, nil
}

func saveState(name string, state *publishingState) error {
	if name == "" {
		return fail("state_required", "请指定 --state")
	}
	if _, err := loadState(name, state.Market, true); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(name), 0700); err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(name), ".beeftv-publish-")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if err = privatefile.Protect(file); err == nil {
		err = json.NewEncoder(file).Encode(state)
	}
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(file.Name(), name)
}

func newCreateKey() (string, error) {
	data := make([]byte, 16)
	if _, err := rand.Read(data); err != nil {
		return "", fmt.Errorf("无法创建幂等标识")
	}
	return "cli-create-" + hex.EncodeToString(data), nil
}
