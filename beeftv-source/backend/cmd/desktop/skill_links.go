package main

import (
	"crypto/sha256"
	"fmt"
	"net/url"
	"path"
	"strings"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
	"infinite-canvas/backend/internal/skillhub"
)

// The OS supplies untrusted links. Only identifiers reach the UI; a link never
// downloads a package, connects an account or confirms an installation.
func skillLinkRoute(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || len(raw) > 1024 || u.Scheme != "beeftv" || u.Host != "skills" || u.Path != "/install" || u.User != nil || u.Fragment != "" || u.Opaque != "" {
		return "", fmt.Errorf("技能链接无效")
	}
	q, err := url.ParseQuery(u.RawQuery)
	if err != nil || len(q) != 2 || len(q["id"]) != 1 || len(q["version"]) != 1 || !skillhub.ResourceID.MatchString(q.Get("id")) || !skillhub.ResourceID.MatchString(q.Get("version")) {
		return "", fmt.Errorf("技能链接必须指定有效的技能和版本")
	}
	return "/skills?" + url.Values{"skillId": {q.Get("id")}, "releaseId": {q.Get("version")}}.Encode(), nil
}

func (a *DesktopApp) queueSkillLink(raw string) {
	route, err := skillLinkRoute(raw)
	if err != nil {
		return
	}
	a.mu.Lock()
	a.pendingSkillLink = route
	ctx := a.wailsCtx
	a.mu.Unlock()
	if ctx != nil {
		wailsruntime.WindowUnminimise(ctx)
		wailsruntime.Show(ctx)
	}
}

// ConsumeSkillLink retains startup links until the frontend has finished booting.
func (a *DesktopApp) ConsumeSkillLink() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	route := a.pendingSkillLink
	a.pendingSkillLink = ""
	return route
}

func skillInstanceID(dataDir string) string {
	return fmt.Sprintf("beeftv-%x", sha256.Sum256([]byte(dataDir)))
}

func validSkillWebsite(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.Fragment != "" || len(raw) > 2048 || strings.Contains(u.Path, "\\") || path.Clean(u.Path) != u.Path || (u.Path != "/skills" && !strings.HasPrefix(u.Path, "/skills/")) {
		return false
	}
	if u.Scheme == "https" && u.Host == "beeftv.app" {
		return true
	}
	// Loopback is the existing SkillHub integration fixture transport.
	return u.Scheme == "http" && (u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost" || u.Hostname() == "::1")
}

func (a *DesktopApp) OpenSkillMarketURL(raw string) error {
	if !validSkillWebsite(raw) {
		return fmt.Errorf("只能打开 BeefTV 技能页面")
	}
	ctx, err := a.dialogContext()
	if err != nil {
		return err
	}
	wailsruntime.BrowserOpenURL(ctx, raw)
	return nil
}
