package conversation

import (
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/gorm"
)

// Store is the SQLite-backed conversation ledger. Callers pass a transaction
// when a later binder must attach a result in the same commit.
type Store interface {
	Available() bool
	DB() *gorm.DB
	CurrentTx() *gorm.DB
	BoundTo(tx *gorm.DB) Store
	Get(tx *gorm.DB, userID, conversationID string) (*model.CreationConversation, error)
	GetByImportOperation(tx *gorm.DB, userID, operationID string) (*model.CreationConversation, error)
	List(tx *gorm.DB, userID string) ([]model.CreationConversation, error)
	ListDeletedIDs(tx *gorm.DB, userID string) ([]string, error)
	Insert(tx *gorm.DB, row *model.CreationConversation) (bool, error)
	CompareAndSwap(tx *gorm.DB, userID, conversationID string, expectedRevision int64, next *model.CreationConversation) (bool, error)
}

type gormStore struct {
	repo *repository.Repository
	tx   *gorm.DB
}

func NewStore(repo *repository.Repository) Store {
	if repo == nil {
		return gormStore{}
	}
	return gormStore{repo: repo}
}

func (s gormStore) Available() bool {
	return s.repo != nil && s.DB() != nil
}

func (s gormStore) DB() *gorm.DB {
	if s.tx != nil {
		return s.tx
	}
	if s.repo == nil {
		return nil
	}
	return s.repo.DB()
}

func (s gormStore) CurrentTx() *gorm.DB { return s.tx }

func (s gormStore) BoundTo(tx *gorm.DB) Store {
	clone := s
	clone.tx = tx
	if tx != nil && s.repo != nil {
		clone.repo = s.repo.WithTx(tx)
	} else if tx != nil {
		clone.repo = repository.New(tx)
	}
	return clone
}

func (s gormStore) Get(tx *gorm.DB, userID, conversationID string) (*model.CreationConversation, error) {
	return s.repo.CreationConversation(firstTx(tx, s.tx), userID, conversationID)
}

func (s gormStore) GetByImportOperation(tx *gorm.DB, userID, operationID string) (*model.CreationConversation, error) {
	return s.repo.CreationConversationByImportOperation(firstTx(tx, s.tx), userID, operationID)
}

func (s gormStore) List(tx *gorm.DB, userID string) ([]model.CreationConversation, error) {
	return s.repo.ListCreationConversations(firstTx(tx, s.tx), userID)
}

func (s gormStore) ListDeletedIDs(tx *gorm.DB, userID string) ([]string, error) {
	return s.repo.ListDeletedCreationConversationIDs(firstTx(tx, s.tx), userID)
}

func (s gormStore) Insert(tx *gorm.DB, row *model.CreationConversation) (bool, error) {
	return s.repo.InsertCreationConversation(firstTx(tx, s.tx), row)
}

func (s gormStore) CompareAndSwap(tx *gorm.DB, userID, conversationID string, expectedRevision int64, next *model.CreationConversation) (bool, error) {
	return s.repo.CompareAndSwapCreationConversation(firstTx(tx, s.tx), userID, conversationID, expectedRevision, next)
}

func firstTx(explicit, bound *gorm.DB) *gorm.DB {
	if explicit != nil {
		return explicit
	}
	return bound
}
