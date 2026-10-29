package conversation

import (
	"encoding/json"
	"errors"
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/gorm"
)

// Service owns /create conversation persistence. CreationRun orchestration
// and pi session transcripts stay outside this type.
type Service struct {
	store Store
	now   func() time.Time
}

func New(store Store) *Service {
	return &Service{store: store, now: func() time.Time { return time.Now().UTC() }}
}

func (s *Service) Available() bool {
	return s.storeReady()
}

// WithRepository returns a copy bound to repo, including a transaction-backed
// repository. Later task binders use this to share one commit.
func (s *Service) WithRepository(repo *repository.Repository) *Service {
	if s == nil {
		return New(NewStore(repo))
	}
	clone := *s
	clone.store = NewStore(repo)
	return &clone
}

// WithTx binds writes to an existing caller transaction. Nested root-DB
// transactions deadlock SQLite, so this must not open a second one.
func (s *Service) WithTx(tx *gorm.DB) *Service {
	if s == nil {
		return nil
	}
	clone := *s
	if s.store == nil {
		clone.store = NewStore(repository.New(tx)).BoundTo(tx)
	} else {
		clone.store = s.store.BoundTo(tx)
	}
	return &clone
}

type Record struct {
	ID        string          `json:"id"`
	Revision  int64           `json:"revision"`
	UpdatedAt time.Time       `json:"updatedAt"`
	Deleted   bool            `json:"deleted,omitempty"`
	Document  json.RawMessage `json:"document,omitempty"`
}

type ListResult struct {
	Conversations []Record `json:"conversations"`
	DeletedIDs    []string `json:"deletedIds"`
}

type ImportResult struct {
	Imported     bool   `json:"imported"`
	ID           string `json:"id"`
	Deleted      bool   `json:"deleted,omitempty"`
	Conversation Record `json:"conversation"`
}

type AttachInput struct {
	ConversationID string
	MessageID      string
	TaskID         string
	EffectKey      string
	ResultURLs     []string
	Status         string
	Content        string
}

func (s *Service) List(userID string) (ListResult, error) {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return ListResult{}, errIdentity()
	}
	if !s.storeReady() {
		return ListResult{}, errUnavailable()
	}
	var result ListResult
	err := s.inTx(func(tx *gorm.DB) error {
		rows, listErr := s.store.List(tx, userID)
		if listErr != nil {
			return listErr
		}
		deleted, deletedErr := s.store.ListDeletedIDs(tx, userID)
		if deletedErr != nil {
			return deletedErr
		}
		records := make([]Record, 0, len(rows))
		for _, row := range rows {
			record, recErr := recordFromRow(&row)
			if recErr != nil {
				return recErr
			}
			records = append(records, record)
		}
		result = ListResult{Conversations: records, DeletedIDs: deleted}
		return nil
	})
	return result, err
}

func (s *Service) Get(userID, conversationID string) (Record, error) {
	userID = strings.TrimSpace(userID)
	conversationID = strings.TrimSpace(conversationID)
	if userID == "" {
		return Record{}, errIdentity()
	}
	if _, err := requiredID(conversationID, "对话"); err != nil {
		return Record{}, err
	}
	if !s.storeReady() {
		return Record{}, errUnavailable()
	}
	var record Record
	err := s.inTx(func(tx *gorm.DB) error {
		row, getErr := s.store.Get(tx, userID, conversationID)
		if getErr != nil {
			if errors.Is(getErr, gorm.ErrRecordNotFound) {
				return errNotFound()
			}
			return getErr
		}
		if row.Deleted {
			return errNotFound()
		}
		decoded, recErr := recordFromRow(row)
		if recErr != nil {
			return recErr
		}
		record = decoded
		return nil
	})
	return record, err
}

func (s *Service) Put(userID, conversationID string, expectedRevision int64, raw json.RawMessage) (Record, error) {
	userID = strings.TrimSpace(userID)
	conversationID = strings.TrimSpace(conversationID)
	if userID == "" {
		return Record{}, errIdentity()
	}
	if expectedRevision < 0 {
		return Record{}, errInvalid("对话版本无效")
	}
	doc, err := NormalizeDocument(conversationID, raw)
	if err != nil {
		return Record{}, err
	}
	if !s.storeReady() {
		return Record{}, errUnavailable()
	}
	var record Record
	err = s.inTx(func(tx *gorm.DB) error {
		existing, getErr := s.store.Get(tx, userID, doc.id)
		now := s.now()
		if errors.Is(getErr, gorm.ErrRecordNotFound) {
			if expectedRevision != 0 {
				return errConflict()
			}
			row := &model.CreationConversation{
				UserID: userID, ConversationID: doc.id, Revision: 1,
				Document: string(doc.raw), CreatedAt: now, UpdatedAt: now,
			}
			inserted, insErr := s.store.Insert(tx, row)
			if insErr != nil {
				return insErr
			}
			if !inserted {
				return errConflict()
			}
			decoded, recErr := recordFromRow(row)
			if recErr != nil {
				return recErr
			}
			record = decoded
			return nil
		}
		if getErr != nil {
			return getErr
		}
		if existing.Deleted {
			return errDeleted()
		}
		if existing.Revision != expectedRevision {
			if existing.Revision == expectedRevision+1 && DocumentHash([]byte(existing.Document)) == DocumentHash(doc.raw) {
				decoded, recErr := recordFromRow(existing)
				if recErr != nil {
					return recErr
				}
				record = decoded
				return nil
			}
			return errConflict()
		}
		next := *existing
		next.Revision = existing.Revision + 1
		next.Document = string(doc.raw)
		next.UpdatedAt = now
		swapped, casErr := s.store.CompareAndSwap(tx, userID, doc.id, expectedRevision, &next)
		if casErr != nil {
			return casErr
		}
		if !swapped {
			return errConflict()
		}
		decoded, recErr := recordFromRow(&next)
		if recErr != nil {
			return recErr
		}
		record = decoded
		return nil
	})
	return record, err
}

func (s *Service) Delete(userID, conversationID string, expectedRevision int64) (Record, error) {
	userID = strings.TrimSpace(userID)
	conversationID = strings.TrimSpace(conversationID)
	if userID == "" {
		return Record{}, errIdentity()
	}
	if _, err := requiredID(conversationID, "对话"); err != nil {
		return Record{}, err
	}
	if expectedRevision < 0 {
		return Record{}, errInvalid("对话版本无效")
	}
	if !s.storeReady() {
		return Record{}, errUnavailable()
	}
	var record Record
	err := s.inTx(func(tx *gorm.DB) error {
		existing, getErr := s.store.Get(tx, userID, conversationID)
		if errors.Is(getErr, gorm.ErrRecordNotFound) {
			if expectedRevision != 0 {
				return errNotFound()
			}
			now := s.now()
			row := &model.CreationConversation{
				UserID: userID, ConversationID: conversationID, Revision: 1,
				Document: "{}", Deleted: true, CreatedAt: now, UpdatedAt: now,
			}
			inserted, insErr := s.store.Insert(tx, row)
			if insErr != nil {
				return insErr
			}
			if !inserted {
				current, curErr := s.store.Get(tx, userID, conversationID)
				if curErr != nil {
					return errConflict()
				}
				if !current.Deleted {
					return errConflict()
				}
				decoded, recErr := recordFromRow(current)
				if recErr != nil {
					return recErr
				}
				decoded.Document = nil
				record = decoded
				return nil
			}
			decoded, recErr := recordFromRow(row)
			if recErr != nil {
				return recErr
			}
			decoded.Document = nil
			record = decoded
			return nil
		}
		if getErr != nil {
			return getErr
		}
		if existing.Deleted {
			decoded, recErr := recordFromRow(existing)
			if recErr != nil {
				return recErr
			}
			decoded.Document = nil
			record = decoded
			return nil
		}
		if existing.Revision != expectedRevision {
			return errConflict()
		}
		next := *existing
		next.Deleted = true
		next.Revision = existing.Revision + 1
		next.UpdatedAt = s.now()
		swapped, casErr := s.store.CompareAndSwap(tx, userID, conversationID, existing.Revision, &next)
		if casErr != nil {
			return casErr
		}
		if !swapped {
			return errConflict()
		}
		decoded, recErr := recordFromRow(&next)
		if recErr != nil {
			return recErr
		}
		decoded.Document = nil
		record = decoded
		return nil
	})
	return record, err
}

func (s *Service) Import(userID, operationID, clientHash string, raw json.RawMessage) (ImportResult, error) {
	userID = strings.TrimSpace(userID)
	operationID = strings.TrimSpace(operationID)
	clientHash = strings.TrimSpace(strings.ToLower(clientHash))
	if userID == "" {
		return ImportResult{}, errIdentity()
	}
	if operationID == "" {
		return ImportResult{}, errInvalid("缺少导入操作标识")
	}
	if !importOperationPattern(operationID) {
		return ImportResult{}, errInvalid("导入操作标识无效")
	}
	doc, err := NormalizeDocument("", raw)
	if err != nil {
		return ImportResult{}, err
	}
	hash := DocumentHash(doc.raw)
	if clientHash != "" && clientHash != hash {
		return ImportResult{}, errConflict()
	}
	if !s.storeReady() {
		return ImportResult{}, errUnavailable()
	}
	var result ImportResult
	err = s.inTx(func(tx *gorm.DB) error {
		byOp, opErr := s.store.GetByImportOperation(tx, userID, operationID)
		if opErr != nil && !errors.Is(opErr, gorm.ErrRecordNotFound) {
			return opErr
		}
		if opErr == nil {
			if byOp.ImportHash != hash {
				return errConflict()
			}
			decoded, recErr := recordFromRow(byOp)
			if recErr != nil {
				return recErr
			}
			result = ImportResult{Imported: false, ID: decoded.ID, Deleted: byOp.Deleted, Conversation: decoded}
			if byOp.Deleted {
				result.Conversation.Document = nil
			}
			return nil
		}
		existing, getErr := s.store.Get(tx, userID, doc.id)
		if getErr != nil && !errors.Is(getErr, gorm.ErrRecordNotFound) {
			return getErr
		}
		if getErr == nil {
			decoded, recErr := recordFromRow(existing)
			if recErr != nil {
				return recErr
			}
			result = ImportResult{Imported: false, ID: decoded.ID, Deleted: existing.Deleted, Conversation: decoded}
			if existing.Deleted {
				result.Conversation.Document = nil
			}
			return nil
		}
		now := s.now()
		row := &model.CreationConversation{
			UserID: userID, ConversationID: doc.id, Revision: 1,
			Document: string(doc.raw), ImportOperationID: operationID, ImportHash: hash,
			CreatedAt: now, UpdatedAt: now,
		}
		inserted, insErr := s.store.Insert(tx, row)
		if insErr != nil {
			if !isUniqueConflict(insErr) {
				return insErr
			}
			return replayImportByOperation(s, tx, userID, operationID, hash, &result)
		}
		if !inserted {
			if replayErr := replayImportByOperation(s, tx, userID, operationID, hash, &result); replayErr == nil {
				return nil
			} else if !isNotFound(replayErr) {
				return replayErr
			}
			current, curErr := s.store.Get(tx, userID, doc.id)
			if curErr != nil {
				return errConflict()
			}
			decoded, recErr := recordFromRow(current)
			if recErr != nil {
				return recErr
			}
			result = ImportResult{Imported: false, ID: decoded.ID, Deleted: current.Deleted, Conversation: decoded}
			if current.Deleted {
				result.Conversation.Document = nil
			}
			return nil
		}
		decoded, recErr := recordFromRow(row)
		if recErr != nil {
			return recErr
		}
		result = ImportResult{Imported: true, ID: decoded.ID, Conversation: decoded}
		return nil
	})
	return result, err
}

// AttachMessageResult updates only result fields of one existing message.
// Task binding itself is not implemented here; a later binder must call this
// inside the same caller transaction via WithTx/WithRepository after it has
// verified the task result's exact ownership.
func (s *Service) AttachMessageResult(userID string, input AttachInput) (Record, error) {
	userID = strings.TrimSpace(userID)
	input.ConversationID = strings.TrimSpace(input.ConversationID)
	input.MessageID = strings.TrimSpace(input.MessageID)
	input.TaskID = strings.TrimSpace(input.TaskID)
	input.EffectKey = strings.TrimSpace(input.EffectKey)
	input.Status = strings.TrimSpace(input.Status)
	if userID == "" {
		return Record{}, errIdentity()
	}
	if _, err := requiredID(input.ConversationID, "对话"); err != nil {
		return Record{}, err
	}
	if _, err := requiredID(input.MessageID, "消息"); err != nil {
		return Record{}, err
	}
	if _, err := requiredID(input.TaskID, "任务"); err != nil {
		return Record{}, err
	}
	if input.Status != "" && input.Status != "done" && input.Status != "error" && input.Status != "cancelled" && input.Status != "pending" && input.Status != "streaming" {
		return Record{}, errInvalid("消息状态无效")
	}
	cleanedURLs := make([]string, 0, len(input.ResultURLs))
	for _, url := range input.ResultURLs {
		text := strings.TrimSpace(url)
		if text == "" {
			continue
		}
		if isTempMediaBlob(text) {
			return Record{}, errInvalid("结果不能包含临时媒体")
		}
		cleanedURLs = append(cleanedURLs, text)
	}
	if !s.storeReady() {
		return Record{}, errUnavailable()
	}
	var record Record
	err := s.inTx(func(tx *gorm.DB) error {
		existing, getErr := s.store.Get(tx, userID, input.ConversationID)
		if errors.Is(getErr, gorm.ErrRecordNotFound) {
			return errNotFound()
		}
		if getErr != nil {
			return getErr
		}
		if existing.Deleted {
			return errDeleted()
		}
		object, decodeErr := decodeObject(json.RawMessage(existing.Document))
		if decodeErr != nil {
			return decodeErr
		}
		messages, _ := object["messages"].([]any)
		var target map[string]any
		for _, item := range messages {
			message, ok := item.(map[string]any)
			if !ok {
				continue
			}
			if strings.TrimSpace(fmtString(message["id"])) == input.MessageID {
				target = message
				break
			}
		}
		if target == nil {
			return errNotFound()
		}
		if !containsString(stringList(target["taskIds"]), input.TaskID) {
			return errMessageTaskMismatch()
		}
		effectKeys := stringList(target["generationEffectKeys"])
		if input.EffectKey != "" && containsString(effectKeys, input.EffectKey) {
			decoded, recErr := recordFromRow(existing)
			if recErr != nil {
				return recErr
			}
			record = decoded
			return nil
		}
		if input.EffectKey != "" {
			effectKeys = append(effectKeys, input.EffectKey)
			asAny := make([]any, 0, len(effectKeys))
			for _, key := range effectKeys {
				asAny = append(asAny, key)
			}
			target["generationEffectKeys"] = asAny
		}
		if len(cleanedURLs) > 0 {
			merged := stringList(target["resultUrls"])
			for _, url := range cleanedURLs {
				if !containsString(merged, url) {
					merged = append(merged, url)
				}
			}
			asAny := make([]any, 0, len(merged))
			for _, url := range merged {
				asAny = append(asAny, url)
			}
			target["resultUrls"] = asAny
		}
		if input.Status != "" {
			target["status"] = input.Status
		}
		if text := strings.TrimSpace(input.Content); text != "" {
			target["content"] = text
		}
		encoded, marshalErr := json.Marshal(object)
		if marshalErr != nil {
			return errInvalid("对话内容无法保存")
		}
		if len(encoded) > maxDocumentBytes {
			return errInvalid("对话内容过大")
		}
		next := *existing
		next.Revision = existing.Revision + 1
		next.Document = string(encoded)
		next.UpdatedAt = s.now()
		swapped, casErr := s.store.CompareAndSwap(tx, userID, input.ConversationID, existing.Revision, &next)
		if casErr != nil {
			return casErr
		}
		if !swapped {
			return errConflict()
		}
		decoded, recErr := recordFromRow(&next)
		if recErr != nil {
			return recErr
		}
		record = decoded
		return nil
	})
	return record, err
}

func (s *Service) storeReady() bool {
	return s != nil && s.store != nil && s.store.Available()
}

func (s *Service) inTx(fn func(*gorm.DB) error) error {
	if !s.storeReady() {
		return errUnavailable()
	}
	if tx := s.store.CurrentTx(); tx != nil {
		return fn(tx)
	}
	db := s.store.DB()
	if db == nil {
		return errUnavailable()
	}
	return db.Transaction(fn)
}

func recordFromRow(row *model.CreationConversation) (Record, error) {
	if row == nil {
		return Record{}, errNotFound()
	}
	record := Record{
		ID:        row.ConversationID,
		Revision:  row.Revision,
		UpdatedAt: row.UpdatedAt,
		Deleted:   row.Deleted,
	}
	if !row.Deleted {
		if strings.TrimSpace(row.Document) == "" || !json.Valid([]byte(row.Document)) {
			return Record{}, errInvalid("对话记录损坏，已保留现场")
		}
		record.Document = json.RawMessage(row.Document)
	}
	return record, nil
}

func importOperationPattern(value string) bool {
	if utf8Len(value) == 0 || utf8Len(value) > 160 {
		return false
	}
	for _, r := range value {
		if (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '.' || r == '_' || r == ':' || r == '-' {
			continue
		}
		return false
	}
	return true
}

func utf8Len(value string) int {
	return len([]rune(value))
}

func replayImportByOperation(s *Service, tx *gorm.DB, userID, operationID, hash string, result *ImportResult) error {
	byOp, opErr := s.store.GetByImportOperation(tx, userID, operationID)
	if errors.Is(opErr, gorm.ErrRecordNotFound) {
		return errNotFound()
	}
	if opErr != nil {
		return opErr
	}
	if byOp.ImportHash != hash {
		return errConflict()
	}
	decoded, recErr := recordFromRow(byOp)
	if recErr != nil {
		return recErr
	}
	*result = ImportResult{Imported: false, ID: decoded.ID, Deleted: byOp.Deleted, Conversation: decoded}
	if byOp.Deleted {
		result.Conversation.Document = nil
	}
	return nil
}

func isUniqueConflict(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(strings.ToLower(err.Error()), "unique constraint failed")
}

func isNotFound(err error) bool {
	var convErr *Error
	return errors.As(err, &convErr) && convErr.Reason == ReasonNotFound
}

func fmtString(value any) string {
	if value == nil {
		return ""
	}
	text, _ := value.(string)
	if text != "" {
		return text
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	return strings.Trim(string(encoded), `"`)
}
