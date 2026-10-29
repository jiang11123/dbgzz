package skillhubcli

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	"infinite-canvas/backend/internal/skillhub"
)

type bundle struct {
	Metadata      skillhub.Metadata `json:"metadata"`
	Files         []skillhub.File   `json:"files"`
	ContentHash   string            `json:"contentHash"`
	ArchiveSHA256 string            `json:"archiveSha256"`
	ArchiveBytes  int               `json:"archiveBytes"`
	Archive       []byte            `json:"-"`
}

var privateLiteral = regexp.MustCompile(`btvpub_[A-Za-z0-9_-]{20,}|-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----`)

func inspectBundle(directory, metadataFile string) (*bundle, error) {
	if directory == "" || metadataFile == "" {
		return nil, fail("metadata_required", "请指定技能目录和 --metadata 文件")
	}
	f, err := os.Open(metadataFile)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var metadata skillhub.Metadata
	decoder := json.NewDecoder(io.LimitReader(f, 64<<10))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&metadata); err != nil {
		return nil, fmt.Errorf("投稿元信息不是有效 JSON：%w", err)
	}
	if metadata.Name == "" || metadata.Description == "" || metadata.License == "" || metadata.VersionLabel == "" {
		return nil, fail("invalid_metadata", "投稿元信息需要名称、简介、许可证和版本")
	}
	if metadata.Requirements == nil {
		metadata.Requirements = []string{}
	}
	if metadata.Showcase == nil {
		metadata.Showcase = []skillhub.Showcase{}
	}
	root, err := filepath.Abs(directory)
	if err != nil {
		return nil, err
	}
	rootInfo, err := os.Lstat(root)
	if err != nil {
		return nil, err
	}
	if !rootInfo.IsDir() || rootInfo.Mode()&os.ModeSymlink != 0 {
		return nil, fail("invalid_directory", "请提供真实的技能目录")
	}
	files := map[string][]byte{}
	caseNames := map[string]bool{}
	var total int64
	err = filepath.WalkDir(root, func(file string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if file == root {
			return nil
		}
		rel, err := filepath.Rel(root, file)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		for _, part := range strings.Split(rel, "/") {
			if strings.HasPrefix(part, ".") || part == "__MACOSX" {
				if entry.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fail("invalid_package", "技能包不能包含软链接")
		}
		if entry.IsDir() {
			if strings.EqualFold(entry.Name(), "scripts") || strings.EqualFold(entry.Name(), "node_modules") {
				return fail("scripts_unsupported", "首版不接收脚本或依赖目录；请保留原技能并使用支持脚本的环境")
			}
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() || info.Mode()&0111 != 0 || !skillhub.DataFilePath(rel) || caseNames[strings.ToLower(rel)] {
			return fail("invalid_package", "技能包包含不安全路径、重复名称或可执行文件")
		}
		ext := strings.ToLower(filepath.Ext(rel))
		name := strings.ToUpper(filepath.Base(rel))
		if ext == "" && (name == "LICENSE" || name == "NOTICE" || name == "COPYING") {
			ext = ".txt"
		}
		limit := int64(2 << 20)
		if rel == "SKILL.md" {
			limit = 256 << 10
		}
		if info.Size() > limit || len(files) >= 256 || total+info.Size() > 20<<20 {
			return fail("package_too_large", "技能文件超过发布大小限制")
		}
		input, err := os.Open(file)
		if err != nil {
			return err
		}
		data, err := io.ReadAll(io.LimitReader(input, limit+1))
		input.Close()
		if err != nil {
			return err
		}
		var stateShape map[string]json.RawMessage
		_ = json.Unmarshal(data, &stateShape)
		if privateLiteral.Match(data) || (stateShape["market"] != nil && stateShape["deviceCode"] != nil) {
			return fail("private_file", "文件疑似含投稿凭据或私钥，请先移除")
		}
		if int64(len(data)) > limit {
			return fail("package_too_large", "技能文件过大")
		}
		if ext != ".png" && ext != ".jpg" && ext != ".jpeg" && ext != ".webp" && ext != ".gif" && !utf8.Valid(data) {
			return fail("invalid_package", "说明和数据文件必须为 UTF-8")
		}
		files[rel] = data
		caseNames[strings.ToLower(rel)] = true
		total += int64(len(data))
		return nil
	})
	if err != nil {
		return nil, err
	}
	if _, err = skillhub.SkillName(files["SKILL.md"]); err != nil {
		return nil, err
	}
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	sort.Strings(names)
	result := &bundle{Metadata: metadata, Files: []skillhub.File{}, ContentHash: skillhub.ContentDigest(files)}
	var archive bytes.Buffer
	writer := zip.NewWriter(&archive)
	for _, name := range names {
		header := &zip.FileHeader{Name: name, Method: zip.Deflate}
		header.SetMode(0600)
		entry, err := writer.CreateHeader(header)
		if err != nil {
			return nil, err
		}
		if _, err = entry.Write(files[name]); err != nil {
			return nil, err
		}
		mimeType := mime.TypeByExtension(filepath.Ext(name))
		if mimeType == "" {
			mimeType = "application/octet-stream"
		}
		result.Files = append(result.Files, skillhub.File{Path: name, SHA256: skillhub.Digest(files[name]), Size: int64(len(files[name])), MimeType: mimeType})
	}
	if err = writer.Close(); err != nil {
		return nil, err
	}
	if archive.Len() > skillhub.MaxArchiveBytes {
		return nil, fail("package_too_large", "压缩包超过10 MiB")
	}
	result.Archive = archive.Bytes()
	result.ArchiveBytes = archive.Len()
	result.ArchiveSHA256 = skillhub.Digest(result.Archive)
	return result, nil
}
