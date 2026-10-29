package handler

import (
	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/skills"
)

// labelAssistantSkills fills skill display labels on host turn records from
// the pins Go validated for that round. The host only echoes pin identity.
// A pin stored without a label (older rounds) falls back to the caller's
// installed skill with the same skill and version; only a pin that resolves
// nowhere stays unlabeled for the UI fallback.
func labelAssistantSkills(turn map[string]any, pins []skills.Pin, installed func() []skills.Pin) {
	if turn == nil {
		return
	}
	labels := make(map[string]skills.Pin, len(pins))
	for _, pin := range pins {
		labels[pin.SkillID] = pin
	}
	resolve := func(id, versionID string) (skills.Pin, bool) {
		if pin, found := labels[id]; found && pin.VersionID == versionID && pin.SkillName != "" {
			return pin, true
		}
		if installed == nil {
			return skills.Pin{}, false
		}
		for _, pin := range installed() {
			if pin.SkillID == id && pin.VersionID == versionID && pin.SkillName != "" {
				return pin, true
			}
		}
		return skills.Pin{}, false
	}
	label := func(value any) {
		list, _ := value.([]any)
		for _, item := range list {
			skill, ok := item.(map[string]any)
			if !ok {
				continue
			}
			delete(skill, "skillName")
			delete(skill, "version")
			id, _ := skill["skillId"].(string)
			versionID, _ := skill["versionId"].(string)
			pin, found := resolve(id, versionID)
			if !found {
				continue
			}
			skill["skillName"] = pin.SkillName
			if pin.Version != "" {
				skill["version"] = pin.Version
			}
		}
	}
	label(turn["skills"])
	inputs, _ := turn["supplementInputs"].([]any)
	for _, value := range inputs {
		if input, ok := value.(map[string]any); ok {
			label(input["skills"])
		}
	}
}

// installedSkillLabels lazily reads the caller's installed skills once per
// response, only when an unlabeled pin needs a name.
func installedSkillLabels(svc *app.Service, userID string) func() []skills.Pin {
	loaded := false
	var pins []skills.Pin
	return func() []skills.Pin {
		if loaded {
			return pins
		}
		loaded = true
		catalog, err := svc.AgentSkillCatalog(userID)
		if err != nil {
			return nil
		}
		for _, item := range catalog {
			pins = append(pins, item.Pin)
		}
		return pins
	}
}
