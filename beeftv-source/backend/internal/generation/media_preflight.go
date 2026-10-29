package generation

import (
	"context"
	"fmt"
	"net/url"
	"strings"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
)

// ValidateMediaTransport uses the same installed contract as execution, without
// reading file bytes, uploading anything, or creating a provider task.
func ValidateMediaTransport(ctx context.Context, input Input) error {
	for kind, transport := range input.Config.ReferenceMediaTransport {
		if (kind != "image" && kind != "video" && kind != "audio") || (transport != "" && transport != "auto" && transport != "inline" && transport != "url" && transport != "link") {
			return &kernel.AppError{Status: 400, Code: 400, Reason: "invalid_reference_transport", Message: "参考素材传输方式无效，请重新选择"}
		}
	}
	if err := validateBytePlusVideoTransport(ctx, input); err != nil {
		return err
	}
	policy := MediaHydrationPolicyFor(ctx, input)
	runtime, _ := RuntimeFromContext(ctx)
	var storageChecked, storageEnabled bool
	var blocked []string
	var required []map[string]any
	groups := []struct {
		label string
		kind  string
		items []Media
	}{
		{"参考图片", "image", input.ReferenceImages}, {"参考视频", "video", input.ReferenceVideos}, {"参考音频", "audio", input.ReferenceAudios},
	}
	if input.Mask != nil {
		groups = append(groups, struct {
			label string
			kind  string
			items []Media
		}{"遮罩", "image", []Media{*input.Mask}})
	}
	for _, group := range groups {
		kind := group.kind
		if group.label == "遮罩" {
			kind = "mask"
		}
		groupPolicy := mediaPolicyForKind(ctx, input, kind, policy)
		if !groupPolicy.RequireURL || groupPolicy.KeepLocal {
			continue
		}
		for i, media := range group.items {
			if group.kind == "video" && isBytePlusVideoInput(input) && !strings.HasPrefix(media.StorageKey, "resource:") {
				continue // The BytePlus check also accepts asset:// identifiers.
			}
			if strings.HasPrefix(media.StorageKey, "resource:") {
				if runtime.Resources != nil && !runtime.Resources.LocalMode() {
					continue // Hosted resources are resolved by the owned resource port.
				}
				if !groupPolicy.ManualURL && runtime.ReferenceStorage != nil {
					if !storageChecked {
						var err error
						storageEnabled, err = runtime.ReferenceStorage.Enabled()
						if err != nil {
							return kernel.WrapAppError(500, "参考素材对象存储配置无法读取，请检查存储设置", err)
						}
						storageChecked = true
					}
					if storageEnabled {
						continue
					}
				}
			} else if address, err := url.Parse(strings.TrimSpace(media.URL)); err == nil && address.Scheme == "https" && address.Hostname() != "" && address.User == nil {
				continue
			}
			blocked = append(blocked, fmt.Sprintf("%s %d", group.label, i+1))
			required = append(required, map[string]any{"kind": group.kind, "index": i, "mask": group.label == "遮罩"})
		}
	}
	if len(blocked) == 0 {
		return nil
	}
	return &kernel.AppError{Status: 400, Code: 400, Reason: "reference_media_requires_url", Details: map[string]any{"requiredReferences": required}, Message: "当前渠道需要在线素材链接：" + strings.Join(blocked, "、") + "无法直接读取。请替换为可访问的 HTTPS 链接，或切换支持本地素材的渠道"}
}

// BytePlus accepts inline images and audio, but reference videos need an online
// URL or asset ID. A local resource would otherwise be hydrated to base64.
func isBytePlusVideoInput(input Input) bool {
	if !model.IsVolcengineArkVideoProtocol(model.ChannelInterfaceType(input.Config.InterfaceType)) {
		return false
	}
	endpoint, err := url.Parse(strings.TrimSpace(input.Config.BaseURL))
	return err == nil && strings.EqualFold(endpoint.Hostname(), "ark.ap-southeast.bytepluses.com")
}

func validateBytePlusVideoTransport(ctx context.Context, input Input) error {
	if !isBytePlusVideoInput(input) {
		return nil
	}
	if input.Config.ChannelID == "" && input.Config.ReferenceMediaTransport["video"] == "inline" && len(input.ReferenceVideos) > 0 {
		return &kernel.AppError{Status: 400, Code: 400, Reason: "invalid_reference_transport", Message: "BytePlus 参考视频不支持直接传素材，请将视频传输方式改为自动、对象存储或在线链接"}
	}
	runtime, _ := RuntimeFromContext(ctx)
	var blocked []string
	var required []map[string]any
	for index, media := range input.ReferenceVideos {
		if strings.HasPrefix(media.StorageKey, "resource:") && !mediaPolicyForKind(ctx, input, "video", MediaHydrationPolicyFor(ctx, input)).ManualURL && runtime.ReferenceStorage != nil {
			enabled, err := runtime.ReferenceStorage.Enabled()
			if err != nil {
				return kernel.WrapAppError(500, "参考素材对象存储配置无法读取，请检查存储设置", err)
			}
			if enabled {
				continue
			}
		}
		address, err := url.Parse(strings.TrimSpace(media.URL))
		remote := err == nil && address.Scheme == "https" && address.Hostname() != "" && address.User == nil
		asset := err == nil && address.Scheme == "asset" && address.Hostname() != "" && address.User == nil && address.Path == "" && address.RawQuery == "" && address.Fragment == ""
		if !strings.HasPrefix(media.StorageKey, "resource:") && (remote || asset) {
			continue
		}
		blocked = append(blocked, fmt.Sprintf("参考视频 %d", index+1))
		required = append(required, map[string]any{"kind": "video", "index": index})
	}
	if len(blocked) == 0 {
		return nil
	}
	return &kernel.AppError{Status: 400, Code: 400, Reason: "reference_media_requires_url", Details: map[string]any{"requiredReferences": required}, Message: "BytePlus 无法直接读取本地参考视频：" + strings.Join(blocked, "、") + "。请改用可公开访问的 HTTPS 视频链接或 BytePlus 素材 ID（asset://），或切换支持本地视频的渠道。图片和音频可以继续使用本地文件"}
}
