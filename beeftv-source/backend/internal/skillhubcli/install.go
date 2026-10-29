package skillhubcli

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"

	"infinite-canvas/backend/internal/skillhub"
)

func pageOptions(a arguments) (int, int, error) {
	values := []int{1, 20}
	for i, key := range []string{"page", "page-size"} {
		if s := a.options[key]; s != "" {
			n, e := strconv.Atoi(s)
			if e != nil || n < 1 || (i == 1 && n > 20) {
				return 0, 0, fail("invalid_pagination", "分页参数无效")
			}
			values[i] = n
		}
	}
	return values[0], values[1], nil
}

func installDestination(a arguments, r *skillhub.Release, files map[string][]byte) (string, error) {
	if a.options["agent"] != "codex" && a.options["agent"] != "claude-code" {
		return "", fail("agent_required", "请使用 --agent 明确选择 codex 或 claude-code")
	}
	if a.options["scope"] != "project" && a.options["scope"] != "user" {
		return "", fail("scope_required", "请使用 --scope 明确选择 project 或 user")
	}
	if !skillhub.ResourceID.MatchString(r.SkillID) {
		return "", fail("invalid_skill_id", "技能标识无效")
	}
	name, err := skillhub.SkillName(files["SKILL.md"])
	if err != nil {
		return "", err
	}
	var root string
	if a.options["scope"] == "project" {
		root = a.options["project"]
		if root == "" {
			var e error
			root, e = os.Getwd()
			if e != nil {
				return "", e
			}
		}
		folder := ".agents"
		if a.options["agent"] == "claude-code" {
			folder = ".claude"
		}
		root = filepath.Join(root, folder, "skills")
	} else {
		home, e := os.UserHomeDir()
		if e != nil {
			return "", e
		}
		if a.options["agent"] == "codex" {
			root = os.Getenv("CODEX_HOME")
			if root == "" {
				root = filepath.Join(home, ".codex")
			}
		} else {
			root = os.Getenv("CLAUDE_CONFIG_DIR")
			if root == "" {
				root = filepath.Join(home, ".claude")
			}
		}
		root = filepath.Join(root, "skills")
	}
	return filepath.Join(root, name), nil
}

func writeRelease(destination string, files map[string][]byte, r *skillhub.Release, origin string) (string, error) {
	dest, err := filepath.Abs(destination)
	if err != nil {
		return "", err
	}
	parent := filepath.Dir(dest)
	if err = os.MkdirAll(parent, 0700); err != nil {
		return "", err
	}
	// Coordinate concurrent invocations before checking the destination. Never
	// overwrite an installed or privately edited skill; updates are explicit.
	lock, err := os.OpenFile(dest+".beeftv-lock", os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return "", &Error{Code: 4, Reason: "install_conflict", Message: "另一个安装正在进行，或遗留安装锁需要检查"}
	}
	lock.Close()
	defer os.Remove(dest + ".beeftv-lock")
	if _, err = os.Lstat(dest); err == nil {
		return "", &Error{Code: 4, Reason: "destination_exists", Message: "目标已存在，原文件已保留；请选择新的目标目录"}
	} else if !os.IsNotExist(err) {
		return "", err
	}
	stage, err := os.MkdirTemp(parent, ".beeftv-skill-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(stage)
	for name, data := range files {
		if !skillhub.SafeFilePath(name) {
			return "", fmt.Errorf("文件路径无效")
		}
		target := filepath.Join(stage, filepath.FromSlash(name))
		if err = os.MkdirAll(filepath.Dir(target), 0700); err != nil {
			return "", err
		}
		if err = os.WriteFile(target, data, 0600); err != nil {
			return "", err
		}
	}
	record, err := json.MarshalIndent(map[string]any{"market": origin, "release": r, "activated": false}, "", "  ")
	if err != nil {
		return "", err
	}
	if err = os.WriteFile(filepath.Join(stage, ".beeftv-install.json"), record, 0600); err != nil {
		return "", err
	}
	if err = os.Rename(stage, dest); err != nil {
		return "", err
	}
	return dest, nil
}
