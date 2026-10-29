package agentops

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// ClientMode 是服务端授予客户端的能力模式。客户端只能出示身份，不能自己声明模式。
type ClientMode string

const (
	ClientReadWrite ClientMode = "read-write"
	ClientReadOnly  ClientMode = "read-only"
)

// ClientKind 只是登记来源的展示分类（codex/claude/cursor/other），不参与任何鉴权判断。
type ClientKind string

const (
	ClientKindCodex         ClientKind = "codex"
	ClientKindClaude        ClientKind = "claude"
	ClientKindClaudeDesktop ClientKind = "claude-desktop"
	ClientKindCursor        ClientKind = "cursor"
	ClientKindOther         ClientKind = "other"
)

// NormalizeClientKind 把未知或历史空值统一收敛成 other：老的登记文件没有 kind 字段。
func NormalizeClientKind(kind string) ClientKind {
	switch ClientKind(strings.TrimSpace(strings.ToLower(kind))) {
	case ClientKindCodex:
		return ClientKindCodex
	case ClientKindClaude:
		return ClientKindClaude
	case ClientKindClaudeDesktop:
		return ClientKindClaudeDesktop
	case ClientKindCursor:
		return ClientKindCursor
	default:
		return ClientKindOther
	}
}

// ClientRegistration 记录一个被本机用户登记过的非交互客户端。
// Kind/LastUsedAt/RevokedAt 是后加字段：历史文件里缺失时按零值解析，读出后统一补默认。
type ClientRegistration struct {
	ID         string     `json:"id"`
	Label      string     `json:"label"`
	Kind       ClientKind `json:"kind,omitempty"`
	Mode       ClientMode `json:"mode"`
	TokenHash  string     `json:"tokenHash"`
	CreatedAt  time.Time  `json:"createdAt"`
	LastUsedAt *time.Time `json:"lastUsedAt,omitempty"`
	RevokedAt  *time.Time `json:"revokedAt,omitempty"`
}

// Revoked 判断该登记是否已被本机用户吊销：吊销后凭据立即失效，且不再出现在列表里。
func (c ClientRegistration) Revoked() bool { return c.RevokedAt != nil }

// lastUsedThrottle 控制 lastUsedAt 的落盘频率：每次读操作都写文件会让登记表成为热点。
const lastUsedThrottle = time.Minute

// ClientRegistry 把登记信息持久化在数据目录里（0600），由本机用户维护。
type ClientRegistry struct {
	mu   sync.Mutex
	path string
}

func NewClientRegistry(dataDir string) *ClientRegistry {
	return &ClientRegistry{path: filepath.Join(dataDir, "agent_clients.json")}
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func (r *ClientRegistry) load() ([]ClientRegistration, error) {
	raw, err := os.ReadFile(r.path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var items []ClientRegistration
	if err := json.Unmarshal(raw, &items); err != nil {
		return nil, err
	}
	// 老版本文件没有 kind：补成 other，后续读写都按同一形状处理。
	for index := range items {
		items[index].Kind = NormalizeClientKind(string(items[index].Kind))
	}
	return items, nil
}

// Register 生成一次性展示的 token，并在服务端保存其哈希与模式。
func (r *ClientRegistry) Register(label string, mode ClientMode) (ClientRegistration, string, error) {
	return r.RegisterKind("", label, mode)
}

// RegisterKind 与 Register 相同，额外记录来源分类（仅用于展示与生成接入说明）。
func (r *ClientRegistry) RegisterKind(kind, label string, mode ClientMode) (ClientRegistration, string, error) {
	if mode == "" {
		mode = ClientReadWrite
	}
	if mode != ClientReadOnly && mode != ClientReadWrite {
		return ClientRegistration{}, "", InvalidArg("invalid_mode", "mode 必须是 read-only 或 read-write")
	}
	normalizedKind := NormalizeClientKind(kind)
	if strings.TrimSpace(label) == "" {
		label = string(normalizedKind)
	}
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return ClientRegistration{}, "", AsError(err)
	}
	idBuf := make([]byte, 8)
	if _, err := rand.Read(idBuf); err != nil {
		return ClientRegistration{}, "", AsError(err)
	}
	token := hex.EncodeToString(buf)
	reg := ClientRegistration{ID: "client-" + hex.EncodeToString(idBuf), Label: label, Kind: normalizedKind, Mode: mode,
		TokenHash: hashToken(token), CreatedAt: time.Now().UTC()}
	r.mu.Lock()
	defer r.mu.Unlock()
	items, err := r.load()
	if err != nil {
		return ClientRegistration{}, "", AsError(err)
	}
	items = append(items, reg)
	if err := r.save(items); err != nil {
		return ClientRegistration{}, "", AsError(err)
	}
	return reg, token, nil
}

// save 必须在持有锁时调用。
func (r *ClientRegistry) save(items []ClientRegistration) error {
	encoded, err := json.MarshalIndent(items, "", "  ")
	if err != nil {
		return err
	}
	return atomicWriteFile(r.path, encoded)
}

// Lookup 按 (clientID, token) 解析身份；返回的是服务端登记的模式。
// 已吊销的登记一律解析失败——吊销后凭据立即失效，不留宽限期。
// 命中时顺带记录最近使用时间，但按节流写盘：读操作不该每次都改文件。
func (r *ClientRegistry) Lookup(clientID, token string) (ClientRegistration, bool) {
	if strings.TrimSpace(clientID) == "" || strings.TrimSpace(token) == "" {
		return ClientRegistration{}, false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	items, err := r.load()
	if err != nil {
		return ClientRegistration{}, false
	}
	want := hashToken(token)
	for index, item := range items {
		if item.ID != clientID || item.Revoked() {
			continue
		}
		// 哈希比较用常量时间，避免按前缀逐字节试探已登记客户端的 token。
		if subtle.ConstantTimeCompare([]byte(item.TokenHash), []byte(want)) != 1 {
			continue
		}
		now := time.Now().UTC()
		if item.LastUsedAt == nil || now.Sub(*item.LastUsedAt) >= lastUsedThrottle {
			items[index].LastUsedAt = &now
			// 写失败不影响本次鉴权：lastUsedAt 只是展示信息。
			_ = r.save(items)
		}
		return items[index], true
	}
	return ClientRegistration{}, false
}

// List 返回未吊销的登记信息（不含 token 本身）。
func (r *ClientRegistry) List() []ClientRegistration {
	r.mu.Lock()
	defer r.mu.Unlock()
	items, err := r.load()
	if err != nil {
		return nil
	}
	live := make([]ClientRegistration, 0, len(items))
	for _, item := range items {
		if !item.Revoked() {
			live = append(live, item)
		}
	}
	return live
}

// Revoke 吊销一个登记：保留记录（带吊销时间）而不是删行，这样凭据不会被后续登记复用，
// 也留下可审计的痕迹。未找到或已吊销都按未找到处理，避免把存在性变成探测手段。
func (r *ClientRegistry) Revoke(clientID string) error {
	clientID = strings.TrimSpace(clientID)
	if clientID == "" {
		return InvalidArg("missing_client_id", "缺少客户端 ID")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	items, err := r.load()
	if err != nil {
		return AsError(err)
	}
	for index, item := range items {
		if item.ID != clientID || item.Revoked() {
			continue
		}
		now := time.Now().UTC()
		items[index].RevokedAt = &now
		if err := r.save(items); err != nil {
			return AsError(err)
		}
		return nil
	}
	return NotFound("client_not_found", "没有这个客户端登记")
}

// atomicWriteFile 先写临时文件再改名，避免并发登记时留下半截文件丢记录。
func atomicWriteFile(path string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".agent-clients-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(name, path)
}

// OwnerTokenPath 是后端与可信本机前端共享的 owner 凭据；只有它能执行写操作与登记客户端。
func OwnerTokenPath(dataDir string) string { return filepath.Join(dataDir, "agent_owner_token") }

// EnsureOwnerToken 读取已有 owner token，不存在则生成（0600）。
func EnsureOwnerToken(dataDir string) (string, error) {
	path := OwnerTokenPath(dataDir)
	if raw, err := os.ReadFile(path); err == nil {
		if token := strings.TrimSpace(string(raw)); token != "" {
			return token, nil
		}
	}
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	token := hex.EncodeToString(buf)
	if err := atomicWriteFile(path, []byte(token)); err != nil {
		return "", err
	}
	return token, nil
}

// OwnerTokenMatches 用常量时间比较 owner 凭据。
func OwnerTokenMatches(dataDir, presented string) bool {
	expected, err := EnsureOwnerToken(dataDir)
	if err != nil || presented == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(expected), []byte(presented)) == 1
}

// HostTokenPath 是内置助手宿主的专属凭据：只由后端注入宿主进程，页面与普通客户端拿不到。
func HostTokenPath(dataDir string) string { return filepath.Join(dataDir, "agent_host_token") }

// HostTokenMatches 判断请求是否来自已鉴权的内置助手宿主。
// 回合归属只认这个身份：owner/已登记客户端即使拿到 turnId，也不能自报归属。
// 取值顺序与 handler.readAgentHostToken 完全一致（显式环境变量优先，其次数据目录文件），
// 否则宿主拿到的是环境变量、这里读的是文件，两边会悄悄对不上。
func HostTokenMatches(dataDir, presented string) bool {
	presented = strings.TrimSpace(presented)
	if presented == "" {
		return false
	}
	expected := strings.TrimSpace(os.Getenv("BEEFTV_AGENT_HOST_TOKEN"))
	if expected == "" {
		if strings.TrimSpace(dataDir) == "" {
			return false
		}
		raw, err := os.ReadFile(HostTokenPath(dataDir))
		if err != nil {
			return false
		}
		expected = strings.TrimSpace(string(raw))
	}
	if expected == "" || len(expected) != len(presented) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(expected), []byte(presented)) == 1
}

// EnsureAgentCredentials 在组合根生成 owner 凭据与宿主凭据；DataDir 为空时明确报错，不写 CWD。
func EnsureAgentCredentials(dataDir string) {
	if strings.TrimSpace(dataDir) == "" {
		return
	}
	if _, err := EnsureOwnerToken(dataDir); err != nil {
		return
	}
	hostPath := filepath.Join(dataDir, "agent_host_token")
	if _, err := os.Stat(hostPath); err == nil {
		return
	}
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return
	}
	_ = atomicWriteFile(hostPath, []byte(hex.EncodeToString(buf)))
}
