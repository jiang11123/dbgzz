package skills

import (
	"encoding/json"
	"fmt"
	"strings"

	"infinite-canvas/backend/internal/skillhub"
)

// The reviewed release belongs to the installed version, outside canonical package bytes.
// Private edits retain this original provenance rather than pretending to be a new release.
func marketReleaseMetadata(raw string) (*skillhub.Release, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	var release skillhub.Release
	if err := json.Unmarshal([]byte(raw), &release); err != nil {
		return nil, fmt.Errorf("读取技能市场版本资料失败: %w", err)
	}
	if release.SkillID == "" || release.ReleaseID == "" {
		return nil, fmt.Errorf("技能市场版本资料缺少发布身份")
	}
	return &release, nil
}
