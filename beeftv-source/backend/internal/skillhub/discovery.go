package skillhub

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net/url"
	"regexp"
	"strconv"
	"unicode/utf8"
)

var ResourceID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)

type Compatibility struct {
	Status  string   `json:"status"`
	Reasons []string `json:"reasons"`
}

type SearchItem struct {
	Kind          string        `json:"kind"`
	SkillID       string        `json:"skillId"`
	ReleaseID     string        `json:"releaseId"`
	VersionLabel  string        `json:"versionLabel"`
	Name          string        `json:"name"`
	Description   string        `json:"description"`
	Author        string        `json:"author"`
	License       string        `json:"license"`
	SourceURL     string        `json:"sourceUrl"`
	Requirements  []string      `json:"requirements"`
	Compatibility Compatibility `json:"compatibility"`
	Verification  string        `json:"verification"`
}

type SearchResult struct {
	Items    []SearchItem `json:"items"`
	Total    int          `json:"total"`
	Page     int          `json:"page"`
	PageSize int          `json:"pageSize"`
	Target   string       `json:"target"`
}

type DiscoveryRelease struct {
	Release       Release       `json:"release"`
	Compatibility Compatibility `json:"compatibility"`
	Verification  string        `json:"verification"`
}

func (c *Client) Discover(ctx context.Context, skillID, releaseID, target string, capabilities []string) (*DiscoveryRelease, error) {
	if !ResourceID.MatchString(skillID) || !ResourceID.MatchString(releaseID) {
		return nil, fmt.Errorf("必须指定有效的技能和发布版本")
	}
	params := url.Values{}
	if target != "" {
		params.Set("target", target)
	}
	for _, capability := range capabilities {
		params.Add("capability", capability)
	}
	var result DiscoveryRelease
	if err := c.JSON(ctx, "GET", "skills/"+skillID+"/releases/"+releaseID+"/discovery?"+params.Encode(), "", "", nil, &result); err != nil {
		return nil, err
	}
	if result.Release.SkillID != skillID || result.Release.ReleaseID != releaseID {
		return nil, fmt.Errorf("技能市场返回了其他发布版本")
	}
	if err := VerifyRelease(&result.Release); err != nil {
		return nil, err
	}
	if result.Compatibility.Status == "" {
		result.Compatibility.Status = "unverified"
	}
	if result.Verification == "" {
		result.Verification = "unverified"
	}
	return &result, nil
}

type FileChunk struct {
	File       File   `json:"file"`
	Encoding   string `json:"encoding"`
	Content    string `json:"content"`
	Offset     int    `json:"offset"`
	NextOffset int    `json:"nextOffset"`
	EOF        bool   `json:"eof"`
}

func (c *Client) File(ctx context.Context, skillID, releaseID, name string, offset, limit int) (*FileChunk, error) {
	if !SafeFilePath(name) || offset < 0 || limit < 0 || limit > 64<<10 || (limit > 0 && limit < 4) {
		return nil, &Error{Status: 400, Reason: "invalid_file_range", Message: "文件路径或读取范围无效"}
	}
	if limit == 0 {
		limit = 32 << 10
	}
	release, err := c.Release(ctx, skillID, releaseID)
	if err != nil {
		return nil, err
	}
	var file *File
	for _, entry := range release.Files {
		if entry.Path == name {
			copy := entry
			file = &copy
			break
		}
	}
	if file == nil {
		return nil, &Error{Status: 404, Reason: "not_found", Message: "文件不在此发布版本清单中"}
	}
	if file.Size < 0 || file.Size > 2<<20 {
		return nil, &Error{Status: 502, Reason: "file_integrity", Message: "文件大小无效"}
	}
	response, err := c.Request(ctx, "GET", "skills/"+skillID+"/releases/"+releaseID+"/file?path="+url.QueryEscape(name), "", "", "", nil)
	if err != nil {
		return nil, &Error{Status: 503, Reason: "market_unavailable", Message: "技能市场暂时无法连接"}
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return nil, Decode(response, nil)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, file.Size+1))
	if err != nil || int64(len(data)) != file.Size || Digest(data) != file.SHA256 {
		return nil, &Error{Status: 502, Reason: "file_integrity", Message: "文件内容与发布版本不符"}
	}
	text := utf8.Valid(data)
	if offset > len(data) || (text && offset < len(data) && !utf8.RuneStart(data[offset])) {
		return nil, &Error{Status: 400, Reason: "invalid_file_range", Message: "文件读取起点无效"}
	}
	end := min(offset+limit, len(data))
	if text {
		for end < len(data) && !utf8.RuneStart(data[end]) {
			end--
		}
	}
	result := &FileChunk{File: *file, Encoding: "utf-8", Content: string(data[offset:end]), Offset: offset, NextOffset: end, EOF: end == len(data)}
	if !text {
		result.Encoding = "base64"
		result.Content = base64.StdEncoding.EncodeToString(data[offset:end])
	}
	return result, nil
}

func (c *Client) Search(ctx context.Context, query, target string, capabilities []string, page, pageSize int) (*SearchResult, error) {
	params := url.Values{"q": {query}, "page": {strconv.Itoa(page)}, "pageSize": {strconv.Itoa(pageSize)}}
	if target != "" {
		params.Set("target", target)
	}
	for _, capability := range capabilities {
		params.Add("capability", capability)
	}
	var result SearchResult
	err := c.JSON(ctx, "GET", "search?"+params.Encode(), "", "", nil, &result)
	return &result, err
}

func (c *Client) Release(ctx context.Context, skillID, releaseID string) (*Release, error) {
	if !ResourceID.MatchString(skillID) || !ResourceID.MatchString(releaseID) {
		return nil, fmt.Errorf("必须指定有效的技能 ID 和发布版本 ID")
	}
	var result Release
	if err := c.JSON(ctx, "GET", "skills/"+skillID+"/releases/"+releaseID, "", "", nil, &result); err != nil {
		return nil, err
	}
	if result.SkillID != skillID || result.ReleaseID != releaseID {
		return nil, fmt.Errorf("技能市场返回了其他发布版本")
	}
	if err := VerifyRelease(&result); err != nil {
		return nil, err
	}
	return &result, nil
}
