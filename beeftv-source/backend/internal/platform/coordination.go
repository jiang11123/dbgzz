package platform

import (
	"context"
	"errors"
	"fmt"
	"infinite-canvas/backend/internal/kernel"
	"math/rand/v2"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

type localRateEntry struct {
	started time.Time
	count   int
}

const (
	MinChannelConcurrencyLimit     = 1
	MaxChannelConcurrencyLimit     = maxRuntimeConcurrency
	defaultChannelConcurrencyValue = 3
)

type channelSlotError struct {
	scope string
	limit int
	err   error
}

func (e channelSlotError) Error() string {
	if errors.Is(e.err, context.DeadlineExceeded) {
		return fmt.Sprintf("等待渠道并发槽位超时（渠道 %s，并发上限 %d）", e.scope, e.limit)
	}
	if errors.Is(e.err, context.Canceled) {
		return fmt.Sprintf("等待渠道并发槽位已取消（渠道 %s，并发上限 %d）", e.scope, e.limit)
	}
	return fmt.Sprintf("获取渠道并发配额失败（渠道 %s，并发上限 %d）：%v", e.scope, e.limit, e.err)
}

func (e channelSlotError) Unwrap() error { return e.err }

func ChannelSlotFailureDetails(err error) (string, string) {
	var slotErr channelSlotError
	if !errors.As(err, &slotErr) {
		return "", ""
	}
	if errors.Is(slotErr, context.DeadlineExceeded) {
		return "channel_concurrency_wait_timeout", slotErr.Error()
	}
	if errors.Is(slotErr, context.Canceled) {
		return "channel_concurrency_wait_cancelled", slotErr.Error()
	}
	return "channel_concurrency_unavailable", slotErr.Error()
}

type Coordinator struct {
	instanceID string
	localMu    sync.Mutex
	localRate  map[string]localRateEntry
	localSlots map[string]map[string]time.Time
}

func NewCoordinator(_ string) (*Coordinator, error) {
	return NewLocalCoordinator(), nil
}

// NewLocalCoordinator deliberately ignores REDIS_URL. Desktop runs as a
// single local process, so process-local rate limits and leases are the
// correct source of truth and the app must not inherit hosted infrastructure
// from the user's shell environment.
func NewLocalCoordinator() *Coordinator {
	return &Coordinator{instanceID: kernel.NewID(), localRate: map[string]localRateEntry{}, localSlots: map[string]map[string]time.Time{}}
}

func (c *Coordinator) Allow(ctx context.Context, key string, limit int, window time.Duration) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	c.localMu.Lock()
	defer c.localMu.Unlock()
	now := time.Now()
	entry := c.localRate[key]
	if entry.started.IsZero() || now.Sub(entry.started) >= window {
		c.localRate[key] = localRateEntry{started: now, count: 1}
		return true, nil
	}
	if entry.count >= limit {
		return false, nil
	}
	entry.count++
	c.localRate[key] = entry
	return true, nil
}

func (c *Coordinator) Acquire(ctx context.Context, scope string, limit int, ttl time.Duration) (func(), bool, error) {
	lease, acquired, err := c.AcquireLease(ctx, scope, limit, ttl)
	if err != nil || !acquired {
		return nil, acquired, err
	}
	return lease.Release, true, nil
}

func (c *Coordinator) AcquireLease(ctx context.Context, scope string, limit int, ttl time.Duration) (*SlotLease, bool, error) {
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	if limit <= 0 || ttl <= 0 {
		return nil, false, errors.New("并发租约参数无效")
	}
	lease := &SlotLease{coordinator: c, scope: scope, token: c.instanceID + ":" + kernel.NewID(), ttl: ttl}
	c.localMu.Lock()
	now := time.Now()
	slots := c.localSlots[scope]
	if slots == nil {
		slots = map[string]time.Time{}
		c.localSlots[scope] = slots
	}
	for token, expiresAt := range slots {
		if !expiresAt.After(now) {
			delete(slots, token)
		}
	}
	if len(slots) >= limit {
		c.localMu.Unlock()
		return nil, false, nil
	}
	slots[lease.token] = now.Add(ttl)
	c.localMu.Unlock()
	return lease, true, nil
}

const CoordinationTimeout = 2 * time.Second

type SlotLease struct {
	coordinator *Coordinator
	scope       string
	token       string
	ttl         time.Duration
	once        sync.Once
}

func (l *SlotLease) Token() string {
	if l == nil {
		return ""
	}
	return l.token
}

func (l *SlotLease) Renew(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	c := l.coordinator
	now := time.Now()
	c.localMu.Lock()
	defer c.localMu.Unlock()
	if !c.localSlots[l.scope][l.token].After(now) {
		return errors.New("并发租约已失效")
	}
	c.localSlots[l.scope][l.token] = now.Add(l.ttl)
	return nil
}

func (l *SlotLease) Release() {
	l.once.Do(func() {
		c := l.coordinator
		c.localMu.Lock()
		defer c.localMu.Unlock()
		delete(c.localSlots[l.scope], l.token)
		if len(c.localSlots[l.scope]) == 0 {
			delete(c.localSlots, l.scope)
		}
	})
}

func (c *Coordinator) AcquireWithWait(ctx context.Context, scope string, limit int, ttl time.Duration) (func(), error) {
	delay := 200 * time.Millisecond
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		release, acquired, err := c.Acquire(ctx, scope, limit, ttl)
		if err != nil {
			return nil, err
		}
		if acquired {
			return release, nil
		}
		// 满载期间退避并错峰，避免每个等待者固定每秒五次同步争抢 Redis。
		wait := time.NewTimer(channelSlotRetryDelay(delay))
		select {
		case <-ctx.Done():
			wait.Stop()
			return nil, ctx.Err()
		case <-wait.C:
		}
		delay = min(delay*2, 2*time.Second)
	}
}

func channelSlotRetryDelay(delay time.Duration) time.Duration {
	// 上限 2s，下半窗口随机等待，保留首轮至少 100ms 的退让。
	return delay/2 + time.Duration(rand.Int64N(int64(delay/2)+1))
}

func (c *Coordinator) CircuitOpen(ctx context.Context, channelID string) (bool, error) {
	return false, ctx.Err()
}

func (c *Coordinator) RecordChannelResult(ctx context.Context, channelID string, failed bool, failureLimit int, openDuration time.Duration) {
	// Channel health is kept by the owning app service in local memory.
}

const RouteCatalogVersionKey = "canvas:logical-model-route-catalog:version"

func (c *Coordinator) RouteCatalogVersion(ctx context.Context) (int64, error) {
	return 0, ctx.Err()
}

func (c *Coordinator) BumpRouteCatalogVersion(ctx context.Context) error {
	return ctx.Err()
}

func routeHealthKey(key string) string { return "canvas:logical-route-health:" + key }

func (c *Coordinator) RouteBlockedUntil(ctx context.Context, key string) (time.Time, error) {
	return time.Time{}, ctx.Err()
}

func (c *Coordinator) BlockRoute(ctx context.Context, key string, until time.Time) error {
	return ctx.Err()
}

func envInt(key string, fallback int) int {
	value, err := strconv.Atoi(strings.TrimSpace(os.Getenv(key)))
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}

func defaultChannelConcurrencyLimit() int {
	return effectiveChannelConcurrencyLimit(envInt("CANVAS_CHANNEL_CONCURRENCY", defaultChannelConcurrencyValue))
}

func effectiveChannelConcurrencyLimit(configured int) int {
	if configured < MinChannelConcurrencyLimit || configured > MaxChannelConcurrencyLimit {
		return defaultChannelConcurrencyValue
	}
	return configured
}

func (s *Service) AcquireChannelSlot(ctx context.Context, channelID string, fallbackScope string, ttl time.Duration) (func(), int, error) {
	setting, err := s.RuntimeConcurrencySetting()
	limit := defaultChannelConcurrencyLimit()
	if err != nil {
		return nil, limit, channelSlotError{scope: kernel.FirstNonEmpty(strings.TrimSpace(channelID), strings.TrimSpace(fallbackScope), "unknown"), limit: limit, err: fmt.Errorf("读取全局并发配置失败：%w", err)}
	}
	limit = setting.ChannelConcurrency
	scope := strings.TrimSpace(channelID)
	if scope != "" {
		channelLimit, err := s.host.ChannelConcurrencyLimit(scope)
		if err != nil {
			return nil, limit, channelSlotError{scope: scope, limit: limit, err: fmt.Errorf("读取渠道并发配置失败：%w", err)}
		}
		if channelLimit > 0 {
			if channelLimit < MinChannelConcurrencyLimit || channelLimit > MaxChannelConcurrencyLimit {
				return nil, limit, channelSlotError{scope: scope, limit: limit, err: errors.New("渠道并发配置超出 1-999 范围")}
			}
			limit = channelLimit
		}
	} else {
		scope = strings.TrimSpace(fallbackScope)
	}
	if scope == "" {
		return nil, limit, channelSlotError{scope: "unknown", limit: limit, err: errors.New("渠道并发范围为空")}
	}
	if s.Coordinator == nil {
		return nil, limit, channelSlotError{scope: scope, limit: limit, err: errors.New("运行时协调器未初始化")}
	}
	release, err := s.Coordinator.AcquireWithWait(ctx, "channel:"+scope, limit, ttl)
	if err != nil {
		return nil, limit, channelSlotError{scope: scope, limit: limit, err: err}
	}
	return release, limit, nil
}

func (s *Service) Close() error {
	return nil
}

func (s *Service) AllowRequest(ctx context.Context, key string, limit int, window time.Duration) (bool, error) {
	if s.Coordinator == nil {
		return false, errors.New("运行时协调器未初始化")
	}
	return s.Coordinator.Allow(ctx, key, limit, window)
}

func (s *Service) RequestRetryAfter(ctx context.Context, key string, window time.Duration) time.Duration {
	if s == nil || s.Coordinator == nil {
		return window
	}
	return s.Coordinator.RateRetryAfter(ctx, key, window)
}

func (s *Service) AcquireCustomRelaySlot(ctx context.Context, userID string, limit int, ttl time.Duration) (func(), bool, error) {
	if s.Coordinator == nil {
		return nil, false, errors.New("运行时协调器未初始化")
	}
	return s.Coordinator.Acquire(ctx, "custom-relay:"+userID, limit, ttl)
}

func (c *Coordinator) LocalRateCount() int {
	if c == nil {
		return 0
	}
	c.localMu.Lock()
	defer c.localMu.Unlock()
	return len(c.localRate)
}

func (c *Coordinator) ClearLocalRate() int {
	if c == nil {
		return 0
	}
	c.localMu.Lock()
	defer c.localMu.Unlock()
	count := len(c.localRate)
	c.localRate = map[string]localRateEntry{}
	return count
}

func (c *Coordinator) RateRetryAfter(ctx context.Context, key string, window time.Duration) time.Duration {
	if c == nil {
		return window
	}
	if err := ctx.Err(); err != nil {
		return window
	}
	c.localMu.Lock()
	defer c.localMu.Unlock()
	if entry, ok := c.localRate[key]; ok {
		return max(time.Second, time.Until(entry.started.Add(window)))
	}
	return time.Second
}

func (s *Service) RecordChannelResult(ctx context.Context, channelID string, failed bool) error {
	policy, err := s.RuntimePolicy()
	if err != nil {
		return err
	}
	if s.Coordinator == nil {
		return errors.New("运行时协调器未初始化")
	}
	s.Coordinator.RecordChannelResult(ctx, channelID, failed, policy.Request.ChannelCircuitFailureCount, time.Duration(policy.Request.ChannelCircuitOpenSeconds)*time.Second)
	return nil
}
