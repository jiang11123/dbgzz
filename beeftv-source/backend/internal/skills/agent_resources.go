package skills

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"path"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
)

// Pin is the exact installed package selected by the user for a business round.
// Instructions are loaded on demand, never persisted as an alternate package.
type Pin struct {
	SkillID     string `json:"skillId"`
	VersionID   string `json:"versionId"`
	ContentHash string `json:"contentHash"`
	// SkillName and Version are display labels captured by ValidateAgentSkills,
	// so a round still names its skill after the package is uninstalled.
	// They never take part in identity or authorization.
	SkillName string `json:"skillName,omitempty"`
	Version   string `json:"version,omitempty"`
}

// Identity drops display labels; compare pins only through it.
func (p Pin) Identity() Pin {
	return Pin{SkillID: p.SkillID, VersionID: p.VersionID, ContentHash: p.ContentHash}
}

type AgentResource struct {
	Pin                     Pin                    `json:"pin"`
	Name                    string                 `json:"name"`
	Description             string                 `json:"description"`
	Version                 string                 `json:"version"`
	Instruction             string                 `json:"instruction"`
	Files                   []SkillPackageFileItem `json:"files"`
	UnsupportedCapabilities []string               `json:"unsupportedCapabilities"`
}

type AgentFile struct {
	Pin                Pin                  `json:"pin"`
	File               SkillPackageFileItem `json:"file"`
	Content            string               `json:"content"`
	ExecutionSupported bool                 `json:"executionSupported"`
}

var agentSkillIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,80}$`)

// Requirements belong to the selected immutable version, not the current
// package or a model-supplied declaration.
func (s *Service) AgentRequirements(userID string, pin Pin) ([]string, error) {
	_, version, _, err := s.agentPackage(userID, pin)
	if err != nil {
		return nil, err
	}
	release, err := marketReleaseMetadata(version.MarketReleaseJSON)
	if err != nil || release == nil {
		return nil, err
	}
	return release.Requirements, nil
}

func ValidatePin(pin Pin) error {
	if !agentSkillIDPattern.MatchString(pin.SkillID) || !agentSkillIDPattern.MatchString(pin.VersionID) || len(pin.ContentHash) != 64 {
		return kernel.BadAuthRequest("技能选择必须包含技能、版本和内容摘要")
	}
	if _, err := hex.DecodeString(pin.ContentHash); err != nil || strings.ToLower(pin.ContentHash) != pin.ContentHash {
		return kernel.BadAuthRequest("技能内容摘要无效")
	}
	return nil
}

func (s *Service) agentPackage(userID string, pin Pin) (*model.Skill, *model.SkillVersion, []model.SkillFile, error) {
	if err := ValidatePin(pin); err != nil {
		return nil, nil, nil, err
	}
	if s == nil || s.repo == nil || strings.TrimSpace(userID) == "" {
		return nil, nil, nil, kernel.Forbidden("无法读取当前用户技能")
	}
	skill, err := s.visibleSkill(userID, pin.SkillID)
	if err != nil {
		return nil, nil, nil, err
	}
	state, err := s.repo.UserSkillState(userID, pin.SkillID)
	if err != nil {
		return nil, nil, nil, err
	}
	if skill.Status != skillStatusEnabled || state == nil || !state.Added {
		return nil, nil, nil, kernel.Forbidden("技能已停用或未安装，请重新选择可用技能")
	}
	version, err := s.repo.SkillVersion(pin.VersionID)
	if err != nil || version.SkillID != pin.SkillID {
		return nil, nil, nil, kernel.WrapAppError(400, "所选技能版本不存在", err)
	}
	if version.ContentHash != pin.ContentHash {
		return nil, nil, nil, kernel.NewAppError(409, "技能版本内容已变化，请重新选择")
	}
	if version.PackageKey != path.Join(pin.SkillID, pin.VersionID+".zip") {
		return nil, nil, nil, kernel.Forbidden("技能包位置无效")
	}
	files, err := s.repo.SkillFiles(version.ID)
	return skill, version, files, err
}

func (s *Service) AgentVersion(userID string, pin Pin) (*AgentResource, error) {
	pin = pin.Identity()
	skill, version, files, err := s.agentPackage(userID, pin)
	if err != nil {
		return nil, err
	}
	result := &AgentResource{Pin: pin, Name: skill.Name, Description: skill.Description, Version: version.VersionLabel, Files: []SkillPackageFileItem{}, UnsupportedCapabilities: []string{}}
	for _, file := range files {
		result.Files = append(result.Files, skillFileItem(file))
		if strings.HasPrefix(file.Path, "scripts/") {
			result.UnsupportedCapabilities = []string{"script_execution"}
		}
	}
	entry, err := s.AgentFile(userID, pin, version.EntryPath)
	if err != nil {
		return nil, err
	}
	result.Instruction = entry.Content
	return result, nil
}

func (s *Service) AgentFile(userID string, pin Pin, filePath string) (*AgentFile, error) {
	pin = pin.Identity()
	_, version, files, err := s.agentPackage(userID, pin)
	if err != nil {
		return nil, err
	}
	normalized, err := normalizeSkillPath(filePath)
	if err != nil {
		return nil, err
	}
	if normalized != filePath {
		return nil, kernel.BadAuthRequest("技能文件路径必须是包内相对路径")
	}
	for _, file := range files {
		if file.Path != normalized {
			continue
		}
		if file.Size > 256<<10 && file.Path == version.EntryPath {
			return nil, &kernel.AppError{Status: 400, Code: 400, Reason: "skill_instruction_too_large", Message: "技能正文超过 256 KiB，请将部分内容移到参考文件"}
		}
		if file.Size > 256<<10 || !isPreviewText(file.MimeType, file.Path) {
			return nil, kernel.BadAuthRequest("辅助文件只支持 256 KiB 以内的文本")
		}
		data, err := s.readSkillArchiveEntry(version, normalized)
		if err != nil {
			return nil, kernel.WrapAppError(400, "所选技能版本文件不可读取，请重新安装或选择可用版本", err)
		}
		sum := sha256.Sum256(data)
		if len(data) > 256<<10 || !utf8.Valid(data) || int64(len(data)) != file.Size || hex.EncodeToString(sum[:]) != file.SHA256 {
			return nil, kernel.NewAppError(409, "技能文件内容校验失败，请重新选择")
		}
		return &AgentFile{Pin: pin, File: skillFileItem(file), Content: string(data), ExecutionSupported: false}, nil
	}
	return nil, kernel.BadAuthRequest("这个文件不在所选技能版本中")
}

func (s *Service) ValidateAgentSkills(userID string, pins []Pin) ([]Pin, error) {
	if len(pins) > 4 {
		return nil, kernel.BadAuthRequest("每轮最多选择 4 个技能")
	}
	seen := map[string]bool{}
	result := make([]Pin, 0, len(pins))
	total := 0
	for _, pin := range pins {
		if seen[pin.SkillID] {
			return nil, kernel.BadAuthRequest("同一轮不能选择同一技能的多个版本")
		}
		seen[pin.SkillID] = true
		resource, err := s.AgentVersion(userID, pin)
		if err != nil {
			return nil, err
		}
		total += len(resource.Instruction)
		if total > 512<<10 {
			return nil, &kernel.AppError{Status: 400, Code: 400, Reason: "skill_instruction_too_large", Message: fmt.Sprintf("所选技能正文总量超过 %d KiB，请减少所选技能", 512)}
		}
		labeled := pin.Identity()
		labeled.SkillName = resource.Name
		labeled.Version = resource.Version
		result = append(result, labeled)
	}
	return result, nil
}

// AgentCatalogItem advertises one installed skill to the assistant by its
// current version. The model loads the full instructions on demand.
type AgentCatalogItem struct {
	Pin         Pin    `json:"pin"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

// AgentCatalog lists the caller's installed, enabled skills at their current
// versions, in a stable order. Pins carry display labels; identity is exact.
func (s *Service) AgentCatalog(userID string) ([]AgentCatalogItem, error) {
	if s == nil || s.repo == nil || strings.TrimSpace(userID) == "" {
		return nil, kernel.Forbidden("无法读取当前用户技能")
	}
	items, err := s.AddedSkills(userID)
	if err != nil {
		return nil, err
	}
	result := []AgentCatalogItem{}
	for _, item := range items {
		pin := Pin{SkillID: item.SkillID, VersionID: item.VersionID, ContentHash: item.ContentHash}
		if item.Status != skillStatusEnabled || ValidatePin(pin) != nil {
			continue
		}
		state, err := s.repo.UserSkillState(userID, item.SkillID)
		if err != nil {
			return nil, err
		}
		if state == nil || !state.Added {
			continue
		}
		pin.SkillName = item.SkillName
		pin.Version = item.Version
		result = append(result, AgentCatalogItem{Pin: pin, Name: item.SkillName, Description: item.Description})
	}
	sort.SliceStable(result, func(i, j int) bool { return result[i].Pin.SkillID < result[j].Pin.SkillID })
	return result, nil
}
