package skills

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"time"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/privatefile"
	"infinite-canvas/backend/internal/skillhub"
)

type marketAuth struct {
	Endpoint    string    `json:"endpoint"`
	DeviceCode  string    `json:"deviceCode,omitempty"`
	AccessToken string    `json:"accessToken,omitempty"`
	ExpiresAt   time.Time `json:"expiresAt"`
}

func (s *Service) marketUserDir(user string) string {
	h := sha256.Sum256([]byte(user))
	return filepath.Join(s.dataDir, "skill-market", hex.EncodeToString(h[:]))
}
func writeMarketJSON(file string, value any) error {
	if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		return err
	}
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(file), ".pending-")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err = privatefile.Protect(f); err == nil {
		_, err = f.Write(data)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(f.Name(), file)
}
func readMarketJSON(file string, out any) error {
	info, err := os.Lstat(file)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() > 1<<20 {
		return kernel.BadAuthRequest("投稿文件无效，请重新连接账号")
	}
	if err = privatefile.Check(file, info); err != nil {
		return kernel.BadAuthRequest("投稿文件权限异常，请重新连接账号")
	}
	b, e := os.ReadFile(file)
	if e != nil {
		return e
	}
	return json.Unmarshal(b, out)
}
func (s *Service) marketToken(user string, c *skillhub.Client) (string, error) {
	var a marketAuth
	e := readMarketJSON(filepath.Join(s.marketUserDir(user), "authorization.json"), &a)
	if e != nil || a.AccessToken == "" || a.Endpoint != c.BaseURL() || time.Now().After(a.ExpiresAt) {
		return "", &skillhub.Error{Status: 401, Reason: "publishing_authorization_required", Message: "请先连接技能投稿账号"}
	}
	return a.AccessToken, nil
}
func (s *Service) MarketAuthorization(ctx context.Context, user string, start bool) (any, error) {
	unlock := s.lockMarket(user)
	defer unlock()
	c, e := marketClient()
	if e != nil {
		return nil, e
	}
	file := filepath.Join(s.marketUserDir(user), "authorization.json")
	website, _ := url.Parse(c.BaseURL())
	website.Path, website.RawQuery, website.Fragment = "/skills", "", ""
	websiteURL := website.String()
	if start {
		var a skillhub.Authorization
		e = c.JSON(ctx, "POST", "authorizations", "", "", map[string]string{"clientName": "BeefTV 创作助手"}, &a)
		if e != nil {
			return nil, e
		}
		e = writeMarketJSON(file, marketAuth{Endpoint: c.BaseURL(), DeviceCode: a.DeviceCode, ExpiresAt: time.Now().Add(time.Duration(a.ExpiresIn) * time.Second)})
		if e != nil {
			return nil, e
		}
		return map[string]any{"userCode": a.UserCode, "verificationUrl": a.VerificationURL, "expiresIn": a.ExpiresIn, "interval": a.Interval, "websiteUrl": websiteURL}, nil
	}
	if _, e = s.marketToken(user, c); e == nil {
		return map[string]any{"connected": true, "websiteUrl": websiteURL}, nil
	}
	var a marketAuth
	if e = readMarketJSON(file, &a); e != nil || a.DeviceCode == "" || a.Endpoint != c.BaseURL() || time.Now().After(a.ExpiresAt) {
		return map[string]any{"connected": false, "websiteUrl": websiteURL}, nil
	}
	var t skillhub.Token
	e = c.JSON(ctx, "POST", "authorizations/token", "", "", map[string]string{"deviceCode": a.DeviceCode}, &t)
	var remote *skillhub.Error
	if errors.As(e, &remote) && (remote.Reason == "authorization_pending" || remote.Reason == "slow_down") {
		return map[string]any{"connected": false, "pending": true, "reason": remote.Reason, "websiteUrl": websiteURL}, nil
	}
	if e != nil {
		return nil, e
	}
	if t.AccessToken == "" || t.ExpiresIn <= 0 {
		return nil, kernel.BadAuthRequest("投稿授权未完成")
	}
	e = writeMarketJSON(file, marketAuth{Endpoint: c.BaseURL(), AccessToken: t.AccessToken, ExpiresAt: time.Now().Add(time.Duration(t.ExpiresIn) * time.Second)})
	return map[string]any{"connected": e == nil, "websiteUrl": websiteURL}, e
}
func (s *Service) MarketDisconnect(ctx context.Context, user string) error {
	unlock := s.lockMarket(user)
	defer unlock()
	c, e := marketClient()
	if e != nil {
		return e
	}
	token, e := s.marketToken(user, c)
	if e == nil {
		e = c.JSON(ctx, "POST", "authorizations/revoke", token, "", map[string]any{}, nil)
		if e != nil {
			return e
		}
	}
	e = os.Remove(filepath.Join(s.marketUserDir(user), "authorization.json"))
	if errors.Is(e, os.ErrNotExist) {
		return nil
	}
	return e
}
