package beefapi

import (
	"encoding/json"
	"strings"
	"unicode"

	"infinite-canvas/backend/internal/providerpreset"
	"infinite-canvas/backend/internal/workspace"
)

const DefaultManagedAssistantModel = "gpt-6-astra"

func applyCatalog(store *workspace.ProviderConfig, models []CatalogModel, previousAccountID, nextAccountID string, authorizationID string) error {
	if store == nil {
		return nil
	}
	effective, _, err := store.LoadEffectiveModelConfig()
	if err != nil {
		return err
	}
	config, err := cloneAnyMap(effective.Config)
	if err != nil {
		return err
	}
	channels, _ := config["channels"].([]any)
	replaced := false
	replaceModels := previousAccountID != "" && nextAccountID != "" && previousAccountID != nextAccountID
	nextModels := make([]any, 0, len(models))
	nextProfiles := make([]any, 0, len(models))
	for _, model := range models {
		nextModels = append(nextModels, model.ID)
		profile := map[string]any{"model": model.ID}
		// A refreshed catalog owns this quote. Clear a stale quote when the
		// current account/model no longer supplies one.
		profile["videoPricing"] = nil
		if pricing, ok := NormalizeCatalogVideoPricing(model.VideoPricing); ok {
			profile["videoPricing"] = pricing
		}
		if model.DisplayName != "" {
			profile["displayName"] = model.DisplayName
		}
		capability, protocol := catalogCapabilityAndProtocol(model)
		if catalogClearsGeneration(model) {
			profile["capability"] = ""
			profile["protocol"] = ""
		} else {
			if capability != "" {
				profile["capability"] = capability
			}
			if protocol != "" {
				profile["protocol"] = protocol
			}
			if capability == "video" {
				if video, ok := NormalizeCatalogVideoCapability(model.VideoCapabilities); ok {
					profile["capabilityConfig"] = map[string]any{"version": 1, "video": video}
					profile["videoCapabilitiesVersion"] = model.VideoCapabilitiesVersion
				}
			}
		}
		nextProfiles = append(nextProfiles, profile)
	}
	for index, raw := range channels {
		channel, ok := raw.(map[string]any)
		if !ok || channel["id"] != ChannelID {
			continue
		}
		if replaceModels {
			channel["models"] = nextModels
			channel["modelProfiles"] = nextProfiles
		} else {
			// Availability belongs to the current account's catalog. Preserve
			// overrides only for models that are still present in that catalog.
			channel["models"], channel["modelProfiles"] = withoutPortraitCatalogEntries(channel["models"], channel["modelProfiles"])
			channel["models"] = nextModels
			available := make(map[string]bool, len(models))
			for _, model := range models {
				available[model.ID] = true
			}
			profiles := make([]any, 0, len(models))
			for _, raw := range mergeProfiles(channel["modelProfiles"], nextProfiles) {
				profile, _ := raw.(map[string]any)
				id, _ := profile["model"].(string)
				if available[id] {
					profiles = append(profiles, raw)
				}
			}
			channel["modelProfiles"] = profiles
		}
		channel["apiKey"] = ""
		channel["credentialRef"] = CredentialRef
		channels[index] = channel
		replaced = true
		break
	}
	if !replaced {
		channels = append([]any{map[string]any{
			"id": ChannelID, "models": nextModels, "modelProfiles": nextProfiles,
			"apiKey": "", "credentialRef": CredentialRef, "enabled": true,
		}}, channels...)
	}
	config["channels"] = channels
	defaultModel := ""
	if authorizationID != "" {
		preferred := DefaultManagedAssistantModel
		for _, raw := range channels {
			channel, _ := raw.(map[string]any)
			if channel["id"] != ChannelID {
				continue
			}
			if aliases, ok := channel["modelAliases"].(map[string]any); ok {
				if alias, ok := aliases[preferred].(string); ok && strings.TrimSpace(alias) != "" {
					preferred = strings.TrimSpace(alias)
				}
			}
		}
		// Only the freshly fetched catalog can establish availability, not a stale merged entry.
		for _, model := range models {
			capability, protocol := catalogCapabilityAndProtocol(model)
			if model.ID == preferred && capability == "text" && (protocol == "chat-completion" || protocol == "claude-api" || protocol == "responses" || protocol == "openai-response") {
				defaultModel = ChannelID + "::" + preferred
				break
			}
		}
	}
	body, err := json.Marshal(config)
	if err != nil {
		return err
	}
	return store.SaveCatalogWithAssistantDefault(body, authorizationID, defaultModel)
}

func clearBeefAPIModels(store *workspace.ProviderConfig) error {
	if store == nil {
		return nil
	}
	effective, _, err := store.LoadEffectiveModelConfig()
	if err != nil {
		return err
	}
	config, err := cloneAnyMap(effective.Config)
	if err != nil {
		return err
	}
	channels, _ := config["channels"].([]any)
	for index, raw := range channels {
		channel, ok := raw.(map[string]any)
		if !ok || channel["id"] != ChannelID {
			continue
		}
		channel["models"] = []any{}
		channel["modelProfiles"] = []any{}
		channel["apiKey"] = ""
		delete(channel, "credentialRef")
		channels[index] = channel
	}
	config["channels"] = channels
	body, err := json.Marshal(config)
	if err != nil {
		return err
	}
	return store.SaveLocalModelConfig(body)
}

func catalogCapability(model CatalogModel) string {
	capability, _ := catalogCapabilityAndProtocol(model)
	return capability
}

func catalogProtocol(model CatalogModel) string {
	_, protocol := catalogCapabilityAndProtocol(model)
	return protocol
}

func catalogCapabilityAndProtocol(model CatalogModel) (capability, protocol string) {
	if contract, ok := providerpreset.BeefAPIImageContract(model.ID); ok {
		return "image", contract.Protocol
	}
	if contract, ok := providerpreset.BeefAPIVideoContract(model.ID); ok {
		return "video", contract.Protocol
	}
	id := strings.ToLower(strings.TrimSpace(model.ID))
	modelType := strings.ToLower(strings.TrimSpace(model.ModelType))
	endpoints := catalogEndpoints(model)
	if catalogClearsGeneration(model) {
		return "", ""
	}
	switch modelType {
	case "text", "image", "video", "audio":
		capability = modelType
	}
	type mapping struct {
		capability string
		protocol   string
		endpoints  []string
	}
	for _, item := range []mapping{
		{capability: "image", protocol: "openai-image", endpoints: []string{"image-generation", "images", "images.generations"}},
		{capability: "video", protocol: "openai-videos", endpoints: []string{"openai-video", "videos", "videos.generations"}},
		{capability: "audio", protocol: "openai-audio", endpoints: []string{"audio.speech", "audio-speech"}},
		{capability: "text", protocol: "openai-response", endpoints: []string{"openai-response", "openai-response-compact", "responses"}},
		{capability: "text", protocol: "claude-api", endpoints: []string{"anthropic", "messages"}},
		{capability: "text", protocol: "gemini-generate-content", endpoints: []string{"gemini"}},
	} {
		if !containsAnyString(endpoints, item.endpoints) {
			continue
		}
		if capability == "" {
			capability = item.capability
		}
		if protocol == "" && (capability == item.capability || capability == "") {
			protocol = item.protocol
		}
	}
	// BeefAPI-only name fallback: /v1/models often tags MiniMax speech/music as
	// generic openai. Use it only when the catalog did not already set a type.
	if capability == "" && protocol == "" && catalogIsSpeechOrMusic(id) {
		return "audio", "openai-audio"
	}
	if capability == "audio" && protocol == "" && (catalogIsSpeechOrMusic(id) || modelType == "audio") {
		protocol = "openai-audio"
	}
	if containsAnyString(endpoints, []string{"openai", "chat.completions"}) {
		if capability == "" {
			capability = "text"
		}
		if protocol == "" && capability == "text" {
			protocol = "chat-completion"
		}
	}
	if protocol == "" {
		switch capability {
		case "image":
			protocol = "openai-image"
		case "video":
			protocol = "openai-videos"
		case "audio":
			protocol = "openai-audio"
		case "text":
			protocol = "chat-completion"
		}
	}
	return capability, protocol
}

func catalogEndpoints(model CatalogModel) []string {
	endpoints := make([]string, 0, len(model.SupportedEndpointTypes))
	for _, endpoint := range model.SupportedEndpointTypes {
		if item := strings.ToLower(strings.TrimSpace(endpoint)); item != "" {
			endpoints = append(endpoints, item)
		}
	}
	return endpoints
}

func catalogClearsGeneration(model CatalogModel) bool {
	id := strings.ToLower(strings.TrimSpace(model.ID))
	modelType := strings.ToLower(strings.TrimSpace(model.ModelType))
	endpoints := catalogEndpoints(model)
	if containsAnyString(endpoints, []string{"audio.transcriptions", "audio-transcriptions", "transcriptions"}) {
		return true
	}
	if modelType != "" && modelType != "audio" {
		return false
	}
	return catalogIsTranscriptionName(id)
}

func catalogIsTranscriptionName(id string) bool {
	return catalogHasNameToken(id, "asr", "stt", "whisper", "transcription", "transcriptions", "transcribe")
}

func catalogIsSpeechOrMusic(id string) bool {
	if catalogIsTranscriptionName(id) {
		return false
	}
	return catalogHasNameToken(id, "speech", "tts", "music")
}

func catalogHasNameToken(id string, tokens ...string) bool {
	want := make(map[string]bool, len(tokens))
	for _, token := range tokens {
		want[token] = true
	}
	for _, part := range strings.FieldsFunc(strings.ToLower(strings.TrimSpace(id)), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsNumber(r)
	}) {
		if want[part] {
			return true
		}
	}
	return false
}

func containsAnyString(values, candidates []string) bool {
	seen := map[string]bool{}
	for _, value := range values {
		seen[value] = true
	}
	for _, candidate := range candidates {
		if seen[candidate] {
			return true
		}
	}
	return false
}

func mergeModelIDs(existing any, incoming []any) []any {
	seen := map[string]bool{}
	result := make([]any, 0)
	appendID := func(value any) {
		id, _ := value.(string)
		id = strings.TrimSpace(id)
		if id == "" || seen[id] {
			return
		}
		seen[id] = true
		result = append(result, id)
	}
	switch items := existing.(type) {
	case []any:
		for _, item := range items {
			appendID(item)
		}
	case []string:
		for _, item := range items {
			appendID(item)
		}
	}
	for _, item := range incoming {
		appendID(item)
	}
	return result
}

func mergeProfiles(existing any, incoming []any) []any {
	byModel := map[string]map[string]any{}
	order := make([]string, 0)
	add := func(value any) {
		profile, ok := value.(map[string]any)
		if !ok {
			return
		}
		model, _ := profile["model"].(string)
		if strings.TrimSpace(model) == "" {
			return
		}
		if _, ok := byModel[model]; !ok {
			order = append(order, model)
		}
		merged := map[string]any{}
		for key, child := range byModel[model] {
			merged[key] = child
		}
		for key, child := range profile {
			merged[key] = child
		}
		byModel[model] = merged
	}
	if items, ok := existing.([]any); ok {
		for _, item := range items {
			add(item)
		}
	}
	for _, item := range incoming {
		add(item)
	}
	result := make([]any, 0, len(order))
	for _, model := range order {
		result = append(result, byModel[model])
	}
	return result
}

func cloneAnyMap(value map[string]any) (map[string]any, error) {
	if value == nil {
		return map[string]any{}, nil
	}
	body, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var clone map[string]any
	if err := json.Unmarshal(body, &clone); err != nil {
		return nil, err
	}
	return clone, nil
}

func RedactConfig(config map[string]any, managed bool) map[string]any {
	if config == nil {
		return config
	}
	redacted, err := cloneAnyMap(config)
	if err != nil {
		return config
	}
	channels, _ := redacted["channels"].([]any)
	for index, raw := range channels {
		channel, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		id, _ := channel["id"].(string)
		if id != ChannelID {
			continue
		}
		apiKey, _ := channel["apiKey"].(string)
		secretKey, _ := channel["secretKey"].(string)
		hasKey := strings.TrimSpace(apiKey) != "" || strings.TrimSpace(secretKey) != "" || managed
		channel["apiKey"] = ""
		channel["secretKey"] = ""
		if managed {
			channel["credentialRef"] = CredentialRef
			channel["hasApiKey"] = true
		} else if hasKey {
			channel["hasApiKey"] = true
		}
		delete(channel, "encryptedApiKey")
		delete(channel, "deviceCode")
		delete(channel, "device_code")
		channels[index] = channel
	}
	redacted["channels"] = channels
	return redacted
}

func PreserveManagedChannel(incoming, existing map[string]any, managed bool) {
	if incoming == nil {
		return
	}
	incomingChannels, _ := incoming["channels"].([]any)
	existingChannels, _ := existing["channels"].([]any)
	existingBeef := findChannel(existingChannels, ChannelID)
	found := false
	for index, raw := range incomingChannels {
		channel, ok := raw.(map[string]any)
		if !ok || channel["id"] != ChannelID {
			continue
		}
		found = true
		delete(channel, "deviceCode")
		delete(channel, "device_code")
		delete(channel, "encryptedApiKey")
		if existingBeef != nil {
			channel["models"] = existingBeef["models"]
			channel["modelProfiles"] = existingBeef["modelProfiles"]
			if baseURL, _ := existingBeef["baseUrl"].(string); strings.TrimSpace(baseURL) != "" {
				channel["baseUrl"] = existingBeef["baseUrl"]
			}
		}
		if managed {
			channel["apiKey"] = ""
			channel["secretKey"] = ""
			channel["credentialRef"] = CredentialRef
		} else if existingBeef != nil {
			incomingKey, _ := channel["apiKey"].(string)
			if incomingKey == "" || incomingKey == workspace.RedactedSecret {
				if previous, ok := existingBeef["apiKey"]; ok {
					channel["apiKey"] = previous
				}
			}
			incomingSecret, _ := channel["secretKey"].(string)
			if incomingSecret == "" || incomingSecret == workspace.RedactedSecret {
				if previous, ok := existingBeef["secretKey"]; ok {
					channel["secretKey"] = previous
				}
			}
		}
		incomingChannels[index] = channel
	}
	if !found && existingBeef != nil {
		cloned, err := cloneAnyMap(existingBeef)
		if err == nil {
			delete(cloned, "deviceCode")
			delete(cloned, "device_code")
			delete(cloned, "encryptedApiKey")
			if managed {
				cloned["apiKey"] = ""
				cloned["secretKey"] = ""
				cloned["credentialRef"] = CredentialRef
			}
			incomingChannels = append([]any{cloned}, incomingChannels...)
		}
	}
	incoming["channels"] = incomingChannels
}

func findChannel(channels []any, id string) map[string]any {
	for _, raw := range channels {
		channel, ok := raw.(map[string]any)
		if ok && channel["id"] == id {
			return channel
		}
	}
	return nil
}

func withoutPortraitCatalogEntries(models, profiles any) ([]any, []any) {
	isPortrait := func(id string) bool { return id == "seedance-2.0-portrait" || id == "seedance-2.5-portrait" }
	keptModels := make([]any, 0)
	for _, raw := range mergeModelIDs(models, nil) {
		id, _ := raw.(string)
		if !isPortrait(id) {
			keptModels = append(keptModels, raw)
		}
	}
	keptProfiles := make([]any, 0)
	if items, ok := profiles.([]any); ok {
		for _, raw := range items {
			profile, _ := raw.(map[string]any)
			id, _ := profile["model"].(string)
			if !isPortrait(id) {
				keptProfiles = append(keptProfiles, raw)
			}
		}
	}
	return keptModels, keptProfiles
}
