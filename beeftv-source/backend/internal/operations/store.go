package operations

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"

	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"infinite-canvas/backend/internal/model"
)

// Store 负责操作记录的持久化去重。它和业务写入共用同一个数据库与同一个事务：
// 只有画布写入与操作记录一起提交，才不会出现「记录写了但业务没写」的假幂等。
type Store struct {
	db *gorm.DB
}

func NewStore(db *gorm.DB) *Store { return &Store{db: db} }

func (s *Store) Available() bool { return s != nil && s.db != nil }

// RunRequest 是一次幂等执行的全部输入。
// TurnID 为空表示这次写入不属于助手回合（CLI/MCP/owner 直连/手工 UI）。
type RunRequest struct {
	UserID               string
	OpID                 string
	Op                   string
	PayloadHash          string
	AlternatePayloadHash string
	TurnID               string
	CanvasID             string
	TurnGuard            TurnGuard
}

// TurnGuard closes the preflight/settlement race on the same connection as
// the operation receipt and canvas mutation. Manual operations have no turn.
type TurnGuard interface {
	VerifyOpenAssistantTurnInTx(tx *gorm.DB, userID, turnID, canvasID string) error
}

// CanonicalJSON 把 params 收成 encoding/json 的稳定字节：对象键按字母序、紧凑、无多余空白。
// 数字用 json.Number 保原样十进制文本，避免 float64 把超过 2^53 的整数收成同一值。
// 非法 JSON 或第一个值之后还有第二个文档时保持原字节，避免只解析前缀。
func CanonicalJSON(payload []byte) []byte {
	trimmed := bytes.TrimSpace(payload)
	if len(trimmed) == 0 {
		return []byte("{}")
	}
	dec := json.NewDecoder(bytes.NewReader(trimmed))
	dec.UseNumber()
	var value any
	if err := dec.Decode(&value); err != nil {
		return append([]byte(nil), payload...)
	}
	offset := int(dec.InputOffset())
	if offset < 0 || offset > len(trimmed) {
		return append([]byte(nil), payload...)
	}
	if rest := bytes.TrimSpace(trimmed[offset:]); len(rest) > 0 {
		return append([]byte(nil), payload...)
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return append([]byte(nil), payload...)
	}
	return encoded
}

// PayloadHash 是幂等键的组成部分：同 opId 同 payload 才允许回读原结果。
func PayloadHash(op string, payload []byte) string {
	sum := sha256.Sum256(append([]byte(op+"\x00"), payload...))
	return hex.EncodeToString(sum[:])
}

func payloadHashAccepted(stored string, req RunRequest) bool {
	if stored == req.PayloadHash {
		return true
	}
	alternate := strings.TrimSpace(req.AlternatePayloadHash)
	return alternate != "" && stored == alternate
}

// RunOutcome 描述一次执行是真正执行了还是回读了历史结果。
type RunOutcome struct {
	Result   []byte
	Replayed bool
}

// Run 在一个事务里执行 fn，并用 opId 做持久化去重。
// opId 为空表示调用方不需要幂等保证（只读操作）。
func (s *Store) Run(ctx context.Context, req RunRequest, fn func(tx *gorm.DB) ([]byte, error)) (RunOutcome, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if !s.Available() {
		return RunOutcome{}, newError(CodeInternal, "op_store_unavailable", "操作记录存储不可用", nil)
	}
	db := s.db.WithContext(ctx)
	if strings.TrimSpace(req.OpID) == "" {
		out, err := fn(db)
		return RunOutcome{Result: out}, err
	}
	var outcome RunOutcome
	err := db.Transaction(func(tx *gorm.DB) error {
		record := model.AgentOpRecord{OpID: req.OpID, UserID: req.UserID, Op: req.Op,
			PayloadHash: req.PayloadHash, Status: "running", TurnID: strings.TrimSpace(req.TurnID)}
		// 重复键是幂等重放的预期路径（下面会回读历史结果），不让 GORM 把它当错误刷日志。
		if err := tx.Session(&gorm.Session{Logger: logger.Default.LogMode(logger.Silent)}).Create(&record).Error; err != nil {
			if !isDuplicateKey(err) {
				return AsError(err)
			}
			var existing model.AgentOpRecord
			if findErr := tx.Where("user_id = ? AND op_id = ?", req.UserID, req.OpID).First(&existing).Error; findErr != nil {
				return AsError(err)
			}
			if existing.Status != "succeeded" {
				return Conflict("operation_in_progress",
					"同一操作正在执行或上次未成功，未回放结果", map[string]any{"opId": req.OpID, "status": existing.Status})
			}
			if !payloadHashAccepted(existing.PayloadHash, req) || existing.Op != req.Op {
				return Conflict("operation_id_reused_with_different_payload",
					"同一操作 ID 已用于不同的请求内容；请换用新的操作 ID",
					map[string]any{"opId": req.OpID, "existingOp": existing.Op})
			}
			outcome = RunOutcome{Result: []byte(existing.ResultJSON), Replayed: true}
			return nil
		}
		if strings.TrimSpace(req.TurnID) != "" {
			if req.TurnGuard == nil {
				return PreconditionFailed("turn_guard_unavailable", "助手轮次校验不可用", nil)
			}
			if err := req.TurnGuard.VerifyOpenAssistantTurnInTx(tx, req.UserID, req.TurnID, req.CanvasID); err != nil {
				return err
			}
		}
		out, runErr := fn(tx)
		if runErr != nil {
			return runErr
		}
		if err := tx.Model(&model.AgentOpRecord{}).Where("user_id = ? AND op_id = ?", req.UserID, req.OpID).
			Updates(map[string]any{"status": "succeeded", "result_json": string(out), "turn_id": strings.TrimSpace(req.TurnID)}).Error; err != nil {
			return AsError(err)
		}
		outcome = RunOutcome{Result: out}
		return nil
	})
	if err != nil {
		var opErr *Error
		if errors.As(err, &opErr) {
			return RunOutcome{}, opErr
		}
		return RunOutcome{}, AsError(err)
	}
	return outcome, nil
}

// RunDomain 把当前事务绑成 Domain 再执行：业务端口拿不到 *gorm.DB。
func (s *Store) RunDomain(ctx context.Context, req RunRequest, binder DomainBinder, fn func(domain Domain) ([]byte, error)) (RunOutcome, error) {
	if binder == nil {
		return RunOutcome{}, newError(CodeInternal, "op_domain_unavailable", "操作域绑定不可用", nil)
	}
	if guard, ok := binder.(TurnGuard); ok {
		req.TurnGuard = guard
	}
	return s.Run(ctx, req, func(tx *gorm.DB) ([]byte, error) {
		domain := binder.BindDomain(tx)
		if domain == nil {
			return nil, newError(CodeInternal, "op_domain_unavailable", "操作域绑定不可用", nil)
		}
		return fn(domain)
	})
}

func isDuplicateKey(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, gorm.ErrDuplicatedKey) {
		return true
	}
	var coder interface{ Code() int }
	if errors.As(err, &coder) {
		switch coder.Code() {
		case 1555, 2067:
			return true
		}
	}
	return strings.Contains(strings.ToUpper(err.Error()), "UNIQUE CONSTRAINT FAILED")
}
