package taskruntime

import (
	"context"
	"errors"
	"time"

	"infinite-canvas/backend/internal/model"
)

// ErrLeaseLost 表示当前执行者已失去槽位或任务租约。运行时不得把这次执行写成成功，
// 也不得把未知的上游接单当成可重新提交的失败。
var ErrLeaseLost = errors.New("任务租约已失效")

// Kind 是一次已领取任务的显式结局。运行时只按这些结局决定是否允许再次领取执行。
type Kind string

const (
	KindCompleted Kind = "completed"
	KindSuspended Kind = "suspended"
	KindUncertain Kind = "uncertain"
	KindCancelled Kind = "cancelled"
	KindFailed    Kind = "failed"
	KindRejected  Kind = "rejected"
	KindLeaseLost Kind = "lease_lost"
)

// Outcome 是执行适配器返回的类型化结果。Applied 只表示适配器已经按租约写入了持久化结局。
type Outcome struct {
	Kind             Kind
	Err              error
	Applied          bool
	ProviderAccepted bool
}

// Resubmittable 只是结局分类：未知接单、租约丢失和挂起都不能当成新的上游提交。
// 它不写入仓库，也不代替路由回执围栏；生产安全由执行适配器的落库和路由 receipt 负责。
func (o Outcome) Resubmittable() bool {
	if o.ProviderAccepted {
		return false
	}
	switch o.Kind {
	case KindUncertain, KindLeaseLost, KindSuspended:
		return false
	default:
		return true
	}
}

// Repository 只覆盖领取与租约。终态写入由执行适配器负责。
type Repository interface {
	ClaimNext(ctx context.Context, owner string, ttl time.Duration) (*model.Task, error)
	RenewLease(ctx context.Context, taskID, owner string, ttl time.Duration) error
	ReleaseLease(taskID, owner string) error
}

// Coordinator 是进程内/跨进程槽位租约端口。
type Coordinator interface {
	AcquireLease(ctx context.Context, scope string, limit int, ttl time.Duration) (SlotLease, bool, error)
}

// SlotLease 与平台槽位租约方法对齐，避免运行时依赖具体 coordinator 实现。
type SlotLease interface {
	Token() string
	Renew(ctx context.Context) error
	Release()
}

// Policy 只提供调度并发和单次执行超时。
type Policy interface {
	WorkerConcurrency(ctx context.Context) (int, error)
	ExecutionTimeout(ctx context.Context, taskType string) (time.Duration, error)
}

// Executor 是一次已领取任务的执行适配器。协议、供应商和结果落库留在适配器内。
// Applied 必须在适配器自己的持久化成功之后才为 true。
type Executor interface {
	Execute(session Session) Outcome
}

// CancelRegistry 把执行取消函数交给生命周期协调器（用户取消仍走现有 cancelActiveTask）。
type CancelRegistry interface {
	Register(taskID string, cancel context.CancelFunc)
	Unregister(taskID string)
}

// WorkerHost 复用既有 platform.Worker，不另建一套后台 goroutine 生命周期。
type WorkerHost interface {
	Start() (context.Context, bool)
	GoLoop(fn func(context.Context)) bool
	GoTask(fn func()) bool
	BeginDrain()
	Stop(ctx context.Context) error
	IsDraining() bool
}

// Session 是一次领取的执行窗口：超时、用户取消和租约续期都作用在同一条 context 上。
type Session interface {
	Context() context.Context
	Task() *model.Task
	Lost() bool
	LostErr() error
}

// Config 是运行时调度参数。零值由 New 填成与现网 worker 相同的租约和轮询间隔。
type Config struct {
	WorkerID         string
	SlotScope        string
	SlotTTL          time.Duration
	TaskLeaseTTL     time.Duration
	ClaimTimeout     time.Duration
	RenewInterval    time.Duration
	DispatchInterval time.Duration
	MaxSlots         int
	NewOwner         func() string
}
