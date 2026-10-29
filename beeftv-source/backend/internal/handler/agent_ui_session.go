package handler

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"infinite-canvas/backend/internal/agentops"
	"infinite-canvas/backend/internal/app"
)

// 内置 UI 会话：短期限、限定 scope 的独立凭据，由后端签发给可信 UI。
// CSRF 层（loopback/同源）只防跨站，不能替代身份层；未认证的 /agent/* 一律拒绝。
type uiSession struct {
	Token     string
	UserID    string
	ExpiresAt time.Time
}

type uiSessionStore struct {
	mu       sync.Mutex
	sessions map[string]uiSession
	ttl      time.Duration
	now      func() time.Time
}

func newUISessionStore() *uiSessionStore {
	return &uiSessionStore{sessions: map[string]uiSession{}, ttl: 30 * time.Minute, now: time.Now}
}

func (s *uiSessionStore) issue(userID string) uiSession {
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return uiSession{}
	}
	now := s.now()
	session := uiSession{Token: hex.EncodeToString(buf), UserID: userID, ExpiresAt: now.Add(s.ttl)}
	s.mu.Lock()
	defer s.mu.Unlock()
	// 清理过期项，避免长期累积。
	for token, item := range s.sessions {
		if !now.Before(item.ExpiresAt) {
			delete(s.sessions, token)
		}
	}
	s.sessions[session.Token] = session
	return session
}

func (s *uiSessionStore) verify(token, userID string) (uiSession, bool) {
	if strings.TrimSpace(token) == "" {
		return uiSession{}, false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	item, ok := s.sessions[token]
	if !ok || !s.now().Before(item.ExpiresAt) {
		return uiSession{}, false
	}
	if subtle.ConstantTimeCompare([]byte(item.UserID), []byte(userID)) != 1 {
		return uiSession{}, false
	}
	return item, true
}

// resolveAgentCapability 统一判定内置助手入口的能力：
// 1) 已登记外部客户端 → 服务端登记的只读/读写模式；
// 2) 内置 UI 会话凭据 → 读写（绑定签发时的用户）；
// 其他一律未认证。
func resolveAgentCapability(c *gin.Context, svc *app.Service, clients *agentops.ClientRegistry, ui *uiSessionStore, userID string) (readOnly bool, identity string, ok bool, reason string) {
	if strings.TrimSpace(c.GetHeader("X-Beeftv-Client")) != "" {
		readOnly, label, err := resolveClientMode(c, svc, clients)
		if err != nil {
			return true, "", false, err.Error()
		}
		return readOnly, label, true, ""
	}
	if _, found := ui.verify(strings.TrimSpace(c.GetHeader("X-Beeftv-Ui-Session")), userID); found {
		return false, "ui-session", true, ""
	}
	return true, "", false, "缺少内置 UI 会话凭据或已登记客户端凭据"
}

// RegisterAgentUISessionRoutes 只在本机同源且能出示 owner 凭据（或显式开发引导）时签发 UI 会话。
func RegisterAgentUISessionRoutes(r gin.IRouter, svc *app.Service, ui *uiSessionStore, desktopTrust func(*http.Request) bool) {
	r.POST("/assistant/ui-session", func(c *gin.Context) {
		if strings.TrimSpace(c.GetHeader("X-Beeftv-Client")) != "" {
			fail(c, http.StatusForbidden, app.BadAuthRequest("外部客户端不能签发界面会话"))
			return
		}
		if !isLoopbackRequest(c.Request) {
			fail(c, http.StatusForbidden, app.BadAuthRequest("只接受本机同源请求"))
			return
		}
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		ownerOK := agentops.OwnerTokenMatches(svc.DataDir(), strings.TrimSpace(c.GetHeader("X-Beeftv-Owner")))
		devBootstrap := strings.TrimSpace(os.Getenv("BEEFTV_UI_BOOTSTRAP")) == "1"
		// The UI bootstrap secret comes through the Wails binding, separately from entry credentials.
		desktopShell := desktopTrust != nil && desktopTrust(c.Request)
		if !ownerOK && !devBootstrap && !desktopShell {
			fail(c, http.StatusForbidden, app.BadAuthRequest("签发内置 UI 会话需要 owner 凭据或显式本地引导"))
			return
		}
		session := ui.issue(user.ID)
		if session.Token == "" {
			fail(c, http.StatusInternalServerError, app.BadAuthRequest("无法签发 UI 会话"))
			return
		}
		ok(c, gin.H{"token": session.Token, "expiresAt": session.ExpiresAt, "scope": "workspace:read-write",
			"bootstrap": map[string]any{"ownerToken": ownerOK, "devBootstrap": devBootstrap, "desktopShell": desktopShell}})
	})
}
