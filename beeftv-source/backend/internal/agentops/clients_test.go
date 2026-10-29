package agentops

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// 已有安装的登记文件没有 kind / lastUsedAt / revokedAt：升级后必须照旧能用，
// 不能因为多了字段就把用户已经配好的外部客户端全部作废。
func TestLoadsPreExistingRegistrationsWithoutNewFields(t *testing.T) {
	dir := t.TempDir()
	// 这份内容就是旧版本写出的形状。
	legacy := `[{"id":"client-legacy","label":"old codex","mode":"read-write","tokenHash":"` +
		hashToken("legacy-token") + `","createdAt":"2026-01-02T03:04:05Z"}]`
	if err := os.WriteFile(filepath.Join(dir, "agent_clients.json"), []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	registry := NewClientRegistry(dir)

	found, ok := registry.Lookup("client-legacy", "legacy-token")
	if !ok {
		t.Fatal("旧登记应继续有效")
	}
	if found.Mode != ClientReadWrite {
		t.Fatalf("旧登记的能力模式应保留，得到 %q", found.Mode)
	}
	if found.Kind != ClientKindOther {
		t.Fatalf("缺失的 kind 应补成 other，得到 %q", found.Kind)
	}
	items := registry.List()
	if len(items) != 1 || items[0].ID != "client-legacy" {
		t.Fatalf("旧登记应出现在列表里：%+v", items)
	}
	if err := registry.Revoke("client-legacy"); err != nil {
		t.Fatalf("旧登记应可吊销：%v", err)
	}
	if _, ok := registry.Lookup("client-legacy", "legacy-token"); ok {
		t.Fatal("吊销后旧登记仍然有效")
	}
}

func TestRegisterKindLookupAndRevoke(t *testing.T) {
	registry := NewClientRegistry(t.TempDir())
	registration, token, err := registry.RegisterKind("codex", "", ClientReadOnly)
	if err != nil {
		t.Fatal(err)
	}
	if registration.Kind != ClientKindCodex {
		t.Fatalf("kind 应为 codex，得到 %q", registration.Kind)
	}
	// 没给名字时用来源分类兜底，界面上不会出现空白一行。
	if registration.Label != "codex" {
		t.Fatalf("空名称应回落到来源分类，得到 %q", registration.Label)
	}
	if registration.LastUsedAt != nil {
		t.Fatal("刚登记的客户端不该有使用时间")
	}

	if _, ok := registry.Lookup(registration.ID, token); !ok {
		t.Fatal("刚登记的凭据应可用")
	}
	// 命中后要记下最近使用时间，界面才能显示哪个客户端还在用。
	items := registry.List()
	if len(items) != 1 || items[0].LastUsedAt == nil {
		t.Fatalf("使用过的登记应带 lastUsedAt：%+v", items)
	}

	if _, ok := registry.Lookup(registration.ID, "wrong-token"); ok {
		t.Fatal("错误 token 不该通过")
	}
	if _, ok := registry.Lookup("client-unknown", token); ok {
		t.Fatal("未登记 ID 不该通过")
	}

	if err := registry.Revoke(registration.ID); err != nil {
		t.Fatal(err)
	}
	if _, ok := registry.Lookup(registration.ID, token); ok {
		t.Fatal("吊销后凭据仍然有效")
	}
	if len(registry.List()) != 0 {
		t.Fatal("已吊销的登记不该出现在列表里")
	}
	// 记录本身要留着：删行会让同一个 ID 有机会被后来的登记复用。
	raw, err := os.ReadFile(registry.path)
	if err != nil {
		t.Fatal(err)
	}
	var stored []ClientRegistration
	if err := json.Unmarshal(raw, &stored); err != nil {
		t.Fatal(err)
	}
	if len(stored) != 1 || stored[0].RevokedAt == nil {
		t.Fatalf("吊销应留下带时间的记录：%s", raw)
	}
	if err := registry.Revoke(registration.ID); err == nil {
		t.Fatal("重复吊销应报未找到")
	}
	if err := registry.Revoke(""); err == nil {
		t.Fatal("空 ID 应被拒绝")
	}
}

// 登记文件里只存哈希：原始 token 只在签发响应里出现一次。
func TestRegistryNeverStoresRawToken(t *testing.T) {
	registry := NewClientRegistry(t.TempDir())
	_, token, err := registry.RegisterKind("cursor", "cursor", ClientReadWrite)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(registry.path)
	if err != nil {
		t.Fatal(err)
	}
	if len(token) == 0 {
		t.Fatal("应签发出 token")
	}
	if strings.Contains(string(raw), token) {
		t.Fatal("登记文件里出现了原始 token")
	}
	info, err := os.Stat(registry.path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("登记文件权限应为 0600，得到 %v", info.Mode().Perm())
	}
}

// lastUsedAt 是展示信息：每次读操作都落盘会把登记表变成热点，所以按节流写。
func TestLastUsedWritesAreThrottled(t *testing.T) {
	registry := NewClientRegistry(t.TempDir())
	registration, token, err := registry.RegisterKind("claude", "claude", ClientReadOnly)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := registry.Lookup(registration.ID, token); !ok {
		t.Fatal("首次查询应通过")
	}
	first := registry.List()[0].LastUsedAt
	if first == nil {
		t.Fatal("首次使用应记录时间")
	}
	for i := 0; i < 20; i++ {
		if _, ok := registry.Lookup(registration.ID, token); !ok {
			t.Fatal("重复查询应通过")
		}
	}
	if got := registry.List()[0].LastUsedAt; !got.Equal(*first) {
		t.Fatalf("节流窗口内不该反复改写 lastUsedAt：%v -> %v", first, got)
	}

	// 把时间推到节流窗口之外，下一次使用就应该刷新。
	stale := first.Add(-2 * lastUsedThrottle)
	items := registry.List()
	items[0].LastUsedAt = &stale
	items[0].TokenHash = hashToken(token)
	if err := registry.save(items); err != nil {
		t.Fatal(err)
	}
	if _, ok := registry.Lookup(registration.ID, token); !ok {
		t.Fatal("节流窗口外的查询应通过")
	}
	if got := registry.List()[0].LastUsedAt; got == nil || !got.After(stale.Add(time.Minute)) {
		t.Fatalf("节流窗口外应刷新 lastUsedAt，得到 %v", got)
	}
}

func TestNormalizeClientKind(t *testing.T) {
	for input, want := range map[string]ClientKind{
		"codex": ClientKindCodex, "CLAUDE": ClientKindClaude, " cursor ": ClientKindCursor,
		"other": ClientKindOther, "": ClientKindOther, "admin": ClientKindOther,
	} {
		if got := NormalizeClientKind(input); got != want {
			t.Fatalf("NormalizeClientKind(%q) = %q，期望 %q", input, got, want)
		}
	}
}
