package assistantturns

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"gorm.io/gorm"
)

// legacyFile is the on-disk JSON shape used before v10. Files are read-only
// migration inputs, preserved byte-for-byte. They never become competing
// truth once a database row exists, including compact identity tombstones.
type legacyFile struct {
	TurnID              string          `json:"turnId"`
	UserID              string          `json:"userId"`
	CanvasID            string          `json:"canvasId"`
	RevisionBefore      int64           `json:"revisionBefore"`
	CreatedAt           string          `json:"createdAt"`
	State               string          `json:"state,omitempty"`
	SelectedNodeIDs     []string        `json:"selectedNodeIds,omitempty"`
	ReferencedAssetIDs  []string        `json:"referencedAssetIds,omitempty"`
	ReferencedCanvasIDs []string        `json:"referencedCanvasIds,omitempty"`
	AssociatedAssetIDs  []string        `json:"associatedAssetIds,omitempty"`
	AssociatedTaskIDs   []string        `json:"associatedTaskIds,omitempty"`
	Undone              bool            `json:"undone"`
	Change              *Change         `json:"change,omitempty"`
	Document            json.RawMessage `json:"document"`
}

func (s *Service) legacyPath(turnID string) string {
	id := NormalizeTurnID(turnID)
	if id == "" || s.jsonDir == "" {
		return ""
	}
	return filepath.Join(s.jsonDir, id+".json")
}

func (s *Service) readLegacyFile(turnID string) (Record, error) {
	path := s.legacyPath(turnID)
	if path == "" {
		return Record{}, os.ErrNotExist
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return Record{}, err
	}
	var file legacyFile
	if err := json.Unmarshal(raw, &file); err != nil {
		return Record{}, &Error{Reason: ReasonCorruptFile, Message: "轮次记录损坏，已保留现场"}
	}
	id := NormalizeTurnID(turnID)
	fileID := NormalizeTurnID(file.TurnID)
	if fileID == "" || fileID != id {
		return Record{}, &Error{Reason: ReasonOwnership, Message: "轮次文件标识与记录不一致"}
	}
	if file.UserID == "" || file.CanvasID == "" {
		return Record{}, &Error{Reason: ReasonOwnership, Message: "轮次文件缺少用户或画布身份"}
	}
	createdAt := time.Now().UTC()
	if file.CreatedAt != "" {
		if parsed, err := time.Parse(time.RFC3339Nano, file.CreatedAt); err == nil {
			createdAt = parsed
		} else if parsed, err := time.Parse(time.RFC3339, file.CreatedAt); err == nil {
			createdAt = parsed
		}
	}
	return Record{
		TurnID:              id,
		UserID:              file.UserID,
		CanvasID:            file.CanvasID,
		RevisionBefore:      file.RevisionBefore,
		CreatedAt:           createdAt,
		State:               file.State,
		SelectedNodeIDs:     uniqueSorted(file.SelectedNodeIDs),
		ReferencedAssetIDs:  uniqueSorted(file.ReferencedAssetIDs),
		ReferencedCanvasIDs: uniqueSorted(file.ReferencedCanvasIDs),
		AssociatedAssetIDs:  uniqueSorted(file.AssociatedAssetIDs),
		AssociatedTaskIDs:   uniqueSorted(file.AssociatedTaskIDs),
		Undone:              file.Undone,
		Change:              file.Change,
		Document:            file.Document,
	}, nil
}

func (s *Service) resolveIdentity(tx *gorm.DB, turnID string) (Record, bool, error) {
	id := NormalizeTurnID(turnID)
	if id == "" {
		return Record{}, false, errInvalidID()
	}
	if s.storeReady() {
		row, err := s.store.Get(tx, id)
		if err == nil {
			rec, recErr := recordFromModel(row)
			return rec, true, recErr
		}
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return Record{}, false, err
		}
	}
	rec, err := s.readLegacyFile(id)
	if isMissing(err) {
		return Record{}, false, nil
	}
	if err != nil {
		return Record{}, false, err
	}
	return rec, true, nil
}

func (s *Service) importLegacyIfMissing(tx *gorm.DB, turnID string) (Record, error) {
	rec, err := s.readLegacyFile(turnID)
	if err != nil {
		return Record{}, err
	}
	if s.store == nil || !s.store.Available() {
		return rec, nil
	}
	inserted, err := s.store.Insert(tx, recordToModel(rec, s.now()))
	if err != nil {
		return Record{}, fmt.Errorf("导入轮次文件失败: %w", err)
	}
	if !inserted {
		existing, getErr := s.store.Get(tx, rec.TurnID)
		if getErr != nil {
			return Record{}, getErr
		}
		got, recErr := recordFromModel(existing)
		if recErr != nil {
			return Record{}, recErr
		}
		if got.UserID != rec.UserID || got.CanvasID != rec.CanvasID {
			return Record{}, &Error{Reason: ReasonOwnership, Message: "轮次文件与已有记录归属不一致"}
		}
		return got, nil
	}
	return rec, nil
}

func isMissing(err error) bool {
	return err != nil && (errors.Is(err, os.ErrNotExist) || errors.Is(err, gorm.ErrRecordNotFound))
}
